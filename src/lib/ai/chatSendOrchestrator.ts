// chatSendOrchestrator — the chat send pipeline facade.
//
// One send flows through the lifecycle stages in this fixed order (the
// ordering is load-bearing; see each stage module's header):
//
//   0a. inlineDeviceLocalImages   (chat/deviceLocalImages)
//   0b. ocrImageAttachments       (ai/imageOcr)
//    1. buildAttachmentContext    (ai/chatTurnPreparation)
//       + thread/history/conversation preparation
//    2. transcribeAttachments     (ai/chatTranscription)
//    3. fetchYouTubeGrounding     (ai/chatTranscription)
//    4. buildChatRequestBody      (ai/chatRequestBuilder)
//    5. stream + retry            (ai/chatStreamRunner)
//       or the non-streaming /api/ai/invoke fallback
//    6. postProcessResponse       (ai/chatResultReconciliation)
//
// This module owns the sequencing, the sign-in gate, the stream retry
// policy, and the invoke fallback. Stage behavior lives in the stage
// modules. The old canvas/grid action-execution path (handleActionPath,
// ChatSendCanvas, responseBlockId plumbing) was removed in C3B — response
// sanitation for leaked action JSON lives on in actionJsonRescue via the
// reconciliation stage.
import {
  transcribeAttachments,
  fetchYouTubeGrounding,
} from "@/lib/ai/chatTranscription";
import type { CachedYouTubeTranscript } from "@/lib/ai/chatTranscription";
import {
  attachmentsForPrompt,
  buildAttachmentContext,
  buildThreadHistory,
  buildConversationArray,
} from "@/lib/ai/chatTurnPreparation";
import { buildChatRequestBody } from "@/lib/ai/chatRequestBuilder";
import {
  createChatStreamFetcher,
  maybeNotifyModelDowngrade,
  runChatStream,
} from "@/lib/ai/chatStreamRunner";
import { postProcessResponse } from "@/lib/ai/chatResultReconciliation";
import { isVideoQuestion } from "@/lib/chat/chatResponseExtractors";
import { ocrImageAttachments } from "@/lib/ai/imageOcr";
import { inlineDeviceLocalImages } from "@/lib/chat/deviceLocalImages";
import { AI_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";

import type {
  PromptMessage,
  FocusedChatAttachment,
} from "@/lib/lyknChat/chatTurnTypes";
import type { BrowserSurfaceContext } from "@/lib/lyknChat/browserChatSend";

/* ------------------------------------------------------------------ */
/*  Re-exported contracts                                              */
/* ------------------------------------------------------------------ */

// The shared chat message/attachment types live in the canonical chat-turn
// module; buildAttachmentContext and maybeAutoNameChat live in their stage
// modules. They are re-exported here so existing
// `from "@/lib/ai/chatSendOrchestrator"` imports (useChatVoiceMode,
// chatThreadRuntime, …) keep resolving.
export type {
  ToolCallEvent,
  ChatNeuronAttachment,
  PromptMessage,
  FocusedChatAttachment,
  CreateAction,
  OrchestratorResult,
} from "@/lib/lyknChat/chatTurnTypes";
export { buildAttachmentContext } from "@/lib/ai/chatTurnPreparation";
export { maybeAutoNameChat } from "@/lib/ai/chatResultReconciliation";

/* ------------------------------------------------------------------ */
/*  Dependency interfaces                                              */
/* ------------------------------------------------------------------ */

export interface ChatSendIdentity {
  customModelId?: string | null;
  selectedModel: string;
  chatId: string | null;
  routeChatId: string | undefined;
  projectId: string | null;
  /** LYKN project the user explicitly scoped this chat to via the "+" menu. */
  scopedProjectId?: string | null;
  /** Display name of the scoped project. */
  scopedProjectName?: string | null;
  userId: string | undefined;
  /** Bearer token for authenticated relative-path API calls (YouTube embed
   *  validation in the reconciliation stage). */
  userToken?: string;
}

export interface ChatSendContext {
  getKnowledgeBaseContext: () => string;
  getCachedWorkspaceSummary: () => { full?: string; media?: string; boards?: string } | null;
  titleRef: { current: string };
}

export interface ChatSendYouTube {
  /** Per-session full-transcript cache, keyed by videoId. Owned by the
   *  engine so it survives across sends within a session. */
  youtubeTranscriptCache: Record<string, CachedYouTubeTranscript>;
}

export interface ChatSendStateCallbacks {
  setChatStatusText: (text: string) => void;
  setChatMessages: (updater: (prev: PromptMessage[]) => PromptMessage[]) => void;
  setIsChatLoading: (v: boolean) => void;
  setChatFlowMode: (v: "idle" | "clarifying" | "generating") => void;
  setConnectionCards: (v: Array<{ title: string; sourceType: "board" | "media"; reason: string }>) => void;
  setShowConnectionCard: (v: boolean) => void;
  setMediaSuggestions: (v: Array<{ title: string; reason: string; noteId: string }>) => void;
  setSelectedMediaIds: (v: Set<string>) => void;
  setShowMediaSuggestion: (v: boolean) => void;
}

export interface ChatSendStreamRefs {
  streamTargetTextRef: { current: string };
  streamDisplayedLenRef: { current: number };
  streamTypingRafRef: { current: number | null };
  streamPromptIdRef: { current: string | null };
  chatScrollRef: { current: HTMLDivElement | null };
  chatUserScrolledUpRef: { current: boolean };
  chatProgrammaticScrollRef: { current: boolean };
}

export interface ChatSendTyping {
  typeResponseIntoChat: (promptId: string, text: string) => Promise<void>;
  maybeRunConversationSummary: () => Promise<void>;
}

export interface ChatSendParams {
  text: string;
  promptId: string;
  /** "+" menu capability mode for this turn (image / web / research). */
  composerMode?: "none" | "image" | "web" | "research" | `create:${string}`;
  /** Studio mode session (Build / Imagine / Research) system prompt — the
   *  server injects it into the stream system prompt as [ACTIVE_MODE]. */
  modeInstructions?: string;
  /** Studio Research source focus (all / web / academic / news / social / finance). */
  researchSourcePref?: string;
  /**
   * Artifact currently open in the preview popup. When present with source, the
   * server forces surgical patches (edits / section_edits / cell_edits) instead
   * of a full rebuild. When `discussOnly` is true (Chat mode), the server only
   * injects read-only context — no edits.
   */
  activeArtifact?: {
    toolName: string;
    title: string;
    /** Board that owns this artifact — ignored when it doesn't match chatId. */
    sourceChatId?: string;
    /** Chat mode: talk about the open panel; do not edit. */
    discussOnly?: boolean;
    templateType?: string;
    sections?: any[];
    content?: string;
    theme?: string;
    font?: string;
    /** React component source (lykn_build_react_artifact edit round-trip). */
    code?: string;
    files?: Array<{ path: string; content: string }>;
    entry?: string;
    todos?: Array<{ id: string; content: string; status: string }>;
    runtimeErrors?: Array<{ message: string; kind?: string; at?: number }>;
    fileContent?: string;
    headers?: string[];
    rows?: any[];
  } | null;
  sentAttachments: FocusedChatAttachment[];
  brickActionData: { imageUrl?: string; videoId?: string } | null;
  chatMessages: PromptMessage[];
  aiThread: Array<{ role: "user" | "assistant"; content: string; model?: string; at?: string }>;
  conversationSummary: string;
  abortController: AbortController;

  identity: ChatSendIdentity;
  context: ChatSendContext;
  youtube: ChatSendYouTube;
  state: ChatSendStateCallbacks;
  streamRefs: ChatSendStreamRefs;
  typing: ChatSendTyping;
  /** Ephemeral browser-tab context for this turn only. Never persisted. */
  surfaceContext?: BrowserSurfaceContext;
}

/* ------------------------------------------------------------------ */
/*  Main orchestrator                                                  */
/* ------------------------------------------------------------------ */

export async function orchestrateChatSend(p: ChatSendParams): Promise<void> {
  const {
    text, promptId, sentAttachments, brickActionData,
    abortController, identity, youtube, state, streamRefs, typing,
  } = p;
  const signal = abortController.signal;
  const isBrickAction = Boolean(brickActionData);
  const cappedText = text.length > 3000 ? text.slice(0, 3000) : text;

  // Phase 0a: read device-local image bytes into the turn. A `lykn-blob://`
  // (local vault) or `lykn-mac://` (Finder) url is readable only by this app,
  // and a provider handed one fails the entire request rather than answering
  // without the image. Runs before OCR so the recovered data URL is something
  // Tesseract can decode too.
  await inlineDeviceLocalImages(sentAttachments);

  // Phase 0b: OCR fallback. Recover text from image attachments BEFORE the
  // attachment context is assembled so the extracted text rides into the
  // prompt. Best-effort + degrade-safe — never blocks on failure.
  await ocrImageAttachments(sentAttachments, signal, state.setChatStatusText);

  const promptAttachments = attachmentsForPrompt(sentAttachments, p.chatMessages);
  const attachmentContext = buildAttachmentContext(promptAttachments);

  p.aiThread.push({
    role: "user",
    content: cappedText + (attachmentContext ? attachmentContext.slice(0, 1000) : ""),
    at: new Date().toISOString(),
  });
  if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);

  if (!identity.userId) {
    const msg = "Sign in to send messages in chat.";
    state.setChatMessages((prev) =>
      prev.map((m) => (m.id === promptId ? { ...m, aiResponse: msg } : m)),
    );
    p.aiThread.push({ role: "assistant", content: msg });
    state.setChatStatusText("Sign in required");
    return;
  }

  const history = buildThreadHistory(p.aiThread);
  const conversationArray = buildConversationArray(p.chatMessages, cappedText);

  const { API_BASE_URL: apiBase } = await import("@/lib/api-config");

  /* Phase 1: transcribe attachments */
  await transcribeAttachments(sentAttachments, apiBase, isBrickAction, signal, state.setChatStatusText);

  /* Phase 2: YouTube grounding for attached videos */
  const asksAboutVideo = !isBrickAction && isVideoQuestion(text);
  const needsFullTranscript = asksAboutVideo || isBrickAction;
  const { youtubeGrounding, youtubeTranscriptSource } = await fetchYouTubeGrounding({
    apiBase,
    needsFullTranscript,
    sentAttachments,
    abortController,
    transcriptCache: youtube.youtubeTranscriptCache,
    setChatStatusText: state.setChatStatusText,
  });

  /* Phase 3: build request body */
  if (signal.aborted) return;
  state.setChatStatusText("");
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));

  const { requestBody } = await buildChatRequestBody({
    p,
    cappedText,
    history,
    conversationArray,
    attachmentContext,
    youtubeGrounding,
    youtubeTranscriptSource,
    promptAttachments,
  });

  /* Phase 4: streaming (with one retry) or the invoke fallback */
  // A turn that comes back with NO usable text — only the connection-
  // trouble fallback, or a clean-but-empty stream — is almost always a
  // transient first-hit failure: a model that just went cold after a model
  // switch, a momentary provider 429 / overload, or a first-token network
  // blip. Re-firing the SAME request once clears the vast majority of
  // these (it's why "sending a second prompt just works"), so we retry the
  // streaming attempt a single time before surfacing the error. Guards:
  //   • only while the abort signal is still live — a user Stop or the 120s
  //     hard timeout already aborted the shared controller and we must not
  //     fight that;
  //   • at most ONE retry — no retry storms against a provider that's
  //     genuinely down (the server already walked its own cross-provider
  //     fallback chain before it ever returned the error).
  const MAX_STREAM_RETRIES = 1;
  const streamReturnedNoUsableText = (t: string) =>
    !t.trim() || t.trim() === AI_TEMPORARY_FAILURE_TEXT;
  const { fetchStream, getPaywallText } = createChatStreamFetcher({
    apiBase,
    requestBody,
    abortController,
  });
  // Wipe the typing-animation state left over from a failed attempt so the
  // retry streams into a clean bubble instead of fighting stale refs.
  const resetStreamTypingState = () => {
    if (streamRefs.streamTypingRafRef.current) {
      clearTimeout(streamRefs.streamTypingRafRef.current);
      streamRefs.streamTypingRafRef.current = null;
    }
    streamRefs.streamTargetTextRef.current = "";
    streamRefs.streamDisplayedLenRef.current = 0;
    streamRefs.streamPromptIdRef.current = null;
  };

  let streamResponse = await fetchStream();
  if (!streamResponse && !getPaywallText() && !signal.aborted) {
    // The first attempt can land exactly while the backend is restarting
    // (dev-server watch reboots, deploys). An immediate retry would hit the
    // same dead socket — a short pause rides out the gap before giving up
    // to the non-streaming fallback.
    state.setChatStatusText("Reconnecting…");
    await new Promise((r) => setTimeout(r, 2500));
    streamResponse = await fetchStream();
  }

  const paywallText = getPaywallText();
  if (!streamResponse && paywallText) {
    const finalText = paywallText;
    state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
    p.aiThread.push({ role: "assistant", content: finalText });
    if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
    state.setChatStatusText("Answered");
    return;
  }

  if (streamResponse) {
    let streamResult = await runChatStream(p, streamResponse, promptId, text);
    let accumulated = streamResult.accumulated;

    for (
      let attempt = 0;
      attempt < MAX_STREAM_RETRIES
        && streamReturnedNoUsableText(accumulated)
        && !signal.aborted;
      attempt++
    ) {
      resetStreamTypingState();
      state.setChatStatusText("Reconnecting…");
      const retryResponse = await fetchStream();
      if (!retryResponse) break;
      streamResult = await runChatStream(p, retryResponse, promptId, text);
      accumulated = streamResult.accumulated;
    }

    if (streamRefs.streamTypingRafRef.current) { clearTimeout(streamRefs.streamTypingRafRef.current); streamRefs.streamTypingRafRef.current = null; }
    if (streamRefs.streamPromptIdRef.current && streamRefs.streamDisplayedLenRef.current < streamRefs.streamTargetTextRef.current.length) {
      state.setChatMessages((prev) => prev.map((m) => (m.id === streamRefs.streamPromptIdRef.current ? { ...m, aiResponse: streamRefs.streamTargetTextRef.current } : m)));
    }
    streamRefs.streamTargetTextRef.current = "";
    streamRefs.streamDisplayedLenRef.current = 0;
    streamRefs.streamPromptIdRef.current = null;

    await postProcessResponse(
      p,
      accumulated,
      promptId,
      youtubeGrounding,
      asksAboutVideo,
      cappedText,
      streamResult.servedModel,
      streamResult.generatedImageUrl,
      streamResult.streamedSources,
    );
  } else {
    /* Non-streaming invoke fallback */
    const invokeTimeout = setTimeout(() => abortController.abort(), 120000);
    const res = await fetch(`${apiBase}/api/ai/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...requestBody, returnActions: false }),
      signal,
    });
    clearTimeout(invokeTimeout);
    maybeNotifyModelDowngrade(res);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const finalText = AI_TEMPORARY_FAILURE_TEXT;
      state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
      p.aiThread.push({ role: "assistant", content: finalText });
      if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
      state.setChatStatusText("Answered");
      return;
    }
    const invokeAiText = String(data?.response || data?.answer || data?.text || "").trim();
    await typing.typeResponseIntoChat(promptId, invokeAiText || "I'm not sure how to answer that. Could you rephrase?");
    await postProcessResponse(
      p,
      invokeAiText,
      promptId,
      youtubeGrounding,
      asksAboutVideo,
      cappedText,
      identity.selectedModel,
    );
  }
}
