import { extractYouTubeVideoId } from "@/lib/media/youtube";
import {
  transcribeAttachments,
  fetchYouTubeGrounding,
  transcribeUploadedVideos,
} from "@/lib/ai/chatTranscription";
import { getAiPrefs } from "@/lib/ai-prefs";
import { persistInstructionPrompt } from "@/lib/voice/tuneInstructions";
import {
  parseLearnedTag,
  stripLearnedTagFromStream,
  stripLearnedTagsFromFinal,
  finalizeVisibleReply,
  postLearnedFact,
  postAutoLearnedFact,
  stripModelTruncationNote,
  stripModelTruncationNoteFromStream,
} from "@/lib/ai/learnedTag";
import {
  parseAppliedTag,
  stripAppliedTagFromStream,
  stripAppliedTagFromFinal,
  postAppliedAttribution,
} from "@/lib/ai/appliedTag";
import type {
  ToolCallEvent,
  ChatNeuronAttachment,
  PromptMessage,
  FocusedChatAttachment,
  CreateAction,
  OrchestratorResult,
} from "@/lib/lyknChat/chatTurnTypes";
import {
  stripToolSyntaxFromStream,
  stripToolSyntaxFromFinal,
} from "@/lib/ai/toolSyntaxStrip";
import { finalizeResearchReport } from "@/lib/ai/researchReportFinalize";
import { ocrImageAttachments } from "@/lib/ai/imageOcr";
import { inlineDeviceLocalImages } from "@/lib/chat/deviceLocalImages";
import { toolRunningStatus } from "@/lib/ai/toolStatusVerbs";
import { isLocalModeAvailable, refreshLocalMode, getLocalModeCached } from "@/lib/localMode";
import { executeAwaitingLocalTool } from "@/lib/ai/localToolExecutor";
import { saveExchange, getMemoryForPrompt, invalidateMemoryCache } from "@/lib/conversationMemory";
import { loadActiveCustomModelId } from "@/lib/modelBuilder/activeCustomModelStorage";
import { CUSTOM_MODELS_ENABLED } from "@/lib/customModelsEnabled";
import { AI_TEMPORARY_FAILURE_TEXT } from "@/lib/ai/userFacingErrors";
import { listAiDrive } from "@/lib/vault/aiDriveContents";
import {
  emitProjectsChanged,
  projectIdFromToolResult,
  PROJECTS_CHANGED_EVENT,
  shouldEmitProjectsChanged,
} from "@/lib/synthesis/projectLiveSync";
import { toast } from "@/components/ui/use-toast";
import {
  rescueInlineBlockMarkup,
  stripStreamingActionJson,
} from "@/lib/ai/actionJsonRescue";
import {
  userRequestedVaultSurface,
  userRequestedVaultDisplay,
} from "@/lib/ai/vaultSurfaceGate";
import { notifyLyknChatsChanged } from "@/lib/lyknChat/chatsChanged";
import { openStudioTab } from "@/lib/studioTabs";
import { openLyknMediaPop } from "@/lib/lyknMediaPop";
import { listInstalledApps, openInstalledApp } from "@/lib/apps/installApp";
import { macAppNames } from "@/lib/macApps";

// The browser's IANA timezone (e.g. "America/Denver"). Sent with each chat
// request so the server can hand the model the user's LOCAL current time +
// offset — otherwise scheduling tools resolve "3pm" against UTC and land
// events hours off.
function resolveLocalTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

// Show a one-shot toast when the server downgrades the model. The server
// annotates responses with `X-Model-Downgraded: from->to` whenever the caller
// requests a model locked behind their plan. Toast once per session per pair
// to avoid spamming chatty users.
const notifiedDowngrades = new Set<string>();

// Per-session memory of which boards we've already auto-named (or tried
// hard enough to). The server is the source of truth — it short-circuits
// on a non-default title — but tracking client-side prevents redundant
// requests on every subsequent message after a successful rename, and
// caps retries on boards that legitimately have no nameable content yet.
const autoNamedBoardsSucceeded = new Set<string>();
const autoNamedBoardsAttempts = new Map<string, number>();
const AUTO_NAME_MAX_ATTEMPTS = 4;

/**
 * Auto-name a chat board from a single user→assistant exchange, mirroring
 * what the regular send path does. Safe to call repeatedly: it self-gates on
 * the placeholder title, a per-session success cache, and a per-board retry
 * budget, so callers (regular text sends *and* Voice Mode turns) don't need to
 * track any of that themselves.
 *
 * Fire-and-forget — errors are swallowed; a missed title just leaves the
 * "New Chat" placeholder in place.
 */
export function maybeAutoNameChat(args: {
  chatId: string | null | undefined;
  userId: string | null | undefined;
  currentTitle: string | null | undefined;
  userMessage: string;
  assistantReply: string;
}): void {
  const namingChatId = args.chatId ? String(args.chatId) : "";
  const currentTitle = String(args.currentTitle || "").trim();
  const titleIsDefault =
    !currentTitle || currentTitle === "New Chat" || currentTitle === "Untitled board";
  const userMessage = String(args.userMessage || "").trim();
  const assistantReply = String(args.assistantReply || "").trim();
  const prevAttempts = namingChatId ? autoNamedBoardsAttempts.get(namingChatId) || 0 : 0;
  if (
    !args.userId ||
    !namingChatId ||
    !titleIsDefault ||
    (!userMessage && !assistantReply) ||
    autoNamedBoardsSucceeded.has(namingChatId) ||
    prevAttempts >= AUTO_NAME_MAX_ATTEMPTS
  ) {
    return;
  }
  autoNamedBoardsAttempts.set(namingChatId, prevAttempts + 1);
  void (async () => {
    try {
      const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
      const res = await fetch(`${apiBase}/api/ai/name-chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: namingChatId,
          userMessage,
          assistantReply,
        }),
      });
      if (!res.ok) return;
      const json = await res.json().catch(() => null);
      // `already_named` (manual rename in another tab, or a previous
      // auto-name that succeeded but raced our local cache) returns
      // applied:false but still includes the live title — treat that
      // as success so we stop retrying and pick up the real title.
      if (json?.reason === "already_named" && typeof json?.title === "string" && json.title.trim()) {
        autoNamedBoardsSucceeded.add(namingChatId);
        return;
      }
      const newTitle = json?.applied && typeof json.title === "string" ? json.title.trim() : "";
      if (!newTitle) return;
      autoNamedBoardsSucceeded.add(namingChatId);
      // Mirror the manual-rename event contract in MobileLyknChat
      // / AppSidebar so LyknChat's rename listener picks up the title
      // (which also syncs `titleRef.current`, preventing the next
      // autosave from writing the stale local copy back).
      window.dispatchEvent(
        new CustomEvent("lyknchat_renamed", {
          detail: { chatId: namingChatId, title: newTitle },
        }),
      );
      notifyLyknChatsChanged();
    } catch {
      // Auto-naming is purely cosmetic — never let a flake bubble up.
    }
  })();
}
function maybeNotifyModelDowngrade(res: Response | null | undefined) {
  if (!res) return;
  const header = res.headers.get("x-model-downgraded");
  if (!header || notifiedDowngrades.has(header)) return;
  notifiedDowngrades.add(header);
  const [from, to] = header.split("->");
  try {
    toast({
      title: "Using a free model for now",
      description: `${from?.trim() || "That model"} needs a higher plan, so we used ${to?.trim() || "a free model"} instead.`,
    });
  } catch { /* toast unavailable */ }
}

/* ------------------------------------------------------------------ */
/*  Shared chat types — canonical home is lyknChat/chatTurnTypes       */
/* ------------------------------------------------------------------ */

// Wave 2 (chat type authority): the shared chat message/attachment types this
// file used to define (PromptMessage, FocusedChatAttachment, ToolCallEvent,
// ChatNeuronAttachment, CreateAction, OrchestratorResult) now live in the
// canonical chat-turn module. They are re-exported here so existing
// `from "@/lib/ai/chatSendOrchestrator"` type imports keep resolving — but
// this file must not define its own copies again.
export type {
  ToolCallEvent,
  ChatNeuronAttachment,
  PromptMessage,
  FocusedChatAttachment,
  CreateAction,
  OrchestratorResult,
} from "@/lib/lyknChat/chatTurnTypes";

// node_id prefixes lykn_loadNeuron uses to discriminate which store the
// neuron lives in. Mirrors the same set the tool handler accepts and is
// also what ChatNeuronCard renders per-kind layouts for.
const LOAD_NEURON_KINDS = new Set(["vault", "belief", "fact", "concept"]);


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
}

export interface ChatSendContext {
  buildLyknChatContext: () => string;
  buildActionLyknChatContext: (opts: {
    blocks: Record<string, any>;
    blockOrder: string[];
    viewportCenter: { x: number; y: number };
    viewportSize: { w: number; h: number };
    focusedBrickIds?: string[];
    wireConnections?: Array<{ id: string; fromId: string; toId: string; fromSide?: string; toSide?: string }>;
  }) => string;
  getKnowledgeBaseContext: () => string;
  getCachedWorkspaceSummary: () => { full?: string; media?: string; boards?: string } | null;
  tiptapJsonToPlainText: (node: any) => string;
  notesContent: any;
  titleRef: { current: string };
}

export interface ChatSendYouTube {
  youtubeTranscriptCache: Record<string, {
    fetchedAt: number;
    title: string;
    url: string;
    transcript: string;
    segments: Array<{ startSec: number; endSec: number; text: string }>;
    source?: string;
  }>;
  youtubeTranscriptFails: Record<string, number>;
  getAllYouTubeBlocks: () => Array<{ videoId: string; url: string; title: string }>;
  buildYouTubeGrounding: (apiBase: string, text: string, signal?: AbortSignal) => Promise<string>;
}

export interface ChatSendAnalysis {
  isVideoQuestion: (s: string) => boolean;
  looksLikeDeflectingQuestion: (s: string) => boolean;
  sanitizeAssistantResponse: (s: string) => string;
  buildDirectVideoAnswerFromGrounding: (grounding: string) => string;
}

export interface ChatSendPostProcessing {
  extractSourceLinks: (text: string) => { cleanText: string; sources: { title: string; url: string }[] };
  extractAiConnections: (text: string) => { connections: Array<{ title: string; sourceType: "board" | "media"; reason: string }>; cleanText: string };
  extractAndApplyTagActions: (text: string) => Promise<string>;
  extractAndEmbedYouTubeUrls: (text: string, promptId: string, blockId: string | null) => Promise<{ urls: { url: string; videoId: string }[]; cleanText: string }>;
  extractAndEmbedMediaItems: (text: string, blockId: string | null) => Promise<{ cleanText: string; pulled: number }>;
  extractWebLinksFromText: (text: string) => string[];
  attachSourcesToBlock: (blockId: string, sources: { title: string; url: string }[]) => void;
}

export interface ChatSendCanvas {
  getCanvasState: () => any;
  updateBlock: (id: string, patch: any) => void;
  deleteBlock: (id: string) => void;
  normalizeAiTextForBlock: (text: string) => string;
  calcAiBubbleSize: (text: string) => { width: number; height: number };
  applyProjectActions: (actions: CreateAction[]) => { created: number; failures: string[] };
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
  typeIntoAiResponseBlock: (blockId: string, text: string) => Promise<void>;
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
  analysis: ChatSendAnalysis;
  postProcessing: ChatSendPostProcessing;
  canvas: ChatSendCanvas;
  state: ChatSendStateCallbacks;
  streamRefs: ChatSendStreamRefs;
  typing: ChatSendTyping;
  supabaseClient: any;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export function buildAttachmentContext(sentAttachments: FocusedChatAttachment[]): string {
  if (!sentAttachments.length) return "";
  return "\n\n[Attached content]\n" + sentAttachments.map((a) => {
    const t = (a.type || "").toLowerCase();
    const label = a.name || a.vaultTitle || "Untitled";
    const parts: string[] = [];
    if (a.vaultContent) parts.push(String(a.vaultContent).slice(0, 1500));
    if (a.pdfText) parts.push(String(a.pdfText).slice(0, 1500));
    if (a.extractedText) parts.push(String(a.extractedText).slice(0, 1500));
    if (a.transcript) parts.push(String(a.transcript).slice(0, 8000));
    // A data URL is bytes, not a location: nothing can fetch it and spelling
    // one out costs thousands of tokens of base64.
    const safeUrl = a.url && !a.url.startsWith("data:") ? a.url : "";
    if (t === "folder") {
      const listing = String(a.vaultContent || a.extractedText || "").slice(0, 8000);
      return (
        `Desktop folder "${label}" — the user attached THIS folder from their Mac. ` +
        `Answer from this listing only. If you need more detail, call local_list_dir or local_read_file ` +
        `on this exact path — not other folders, the rest of the disk, or the vault. ` +
        `You may offer to read a specific file inside this folder.\n` +
        (listing || "(empty listing)")
      );
    }
    if (t === "vault" || t === "note") {
      return `${t === "note" ? "Note" : "Vault"} "${label}": ${parts.join("\n") || "(empty)"}`;
    }
    if (t === "pdf") {
      // No text means no text layer — a scan or an export of images. Say so,
      // because the alternative is the model inventing contents.
      const body =
        parts.join("\n") ||
        (safeUrl
          ? `(PDF at ${safeUrl})`
          : "(no text could be extracted — this PDF has no text layer, likely a scan. Say so rather than guessing at its contents.)");
      return `PDF "${label}": ${body}`;
    }
    if (t === "document") return `Document "${label}": ${parts.join("\n") || "(could not extract text)"}`;
    if (t === "youtube") {
      const ctx = parts.length ? parts.join("\n") : "";
      return `YouTube video "${label}"${a.videoId ? ` (${a.videoId})` : ""}${safeUrl ? ` — ${safeUrl}` : ""}${ctx ? `\nTranscript: ${ctx}` : ""}`;
    }
    if (t === "video" || t === "audio") {
      return `${t === "video" ? "Video" : "Audio"} "${label}"${parts.length ? `\nTranscript: ${parts.join("\n")}` : " (no transcript available)"}`;
    }
    if (t === "image") {
      const desc = a.aiDescription ? `\nWhat the image shows: ${String(a.aiDescription).slice(0, 1200)}` : "";
      const ocr = a.ocrText ? `\nText extracted from this image (OCR — may contain errors): ${String(a.ocrText).slice(0, 1500)}` : "";
      return `Image "${label}"${safeUrl ? ` — ${safeUrl}` : ""}${desc}${ocr}`;
    }
    if (t === "link") return `Link "${label}"${safeUrl ? ` — ${safeUrl}` : ""}${parts.length ? `\nContent: ${parts.join("\n")}` : ""}`;
    if (parts.length) return `${label}: ${parts.join("\n")}`;
    if (safeUrl) return `${t || "File"} "${label}" — ${safeUrl}`;
    return `${t || "File"}: ${label}`;
  }).join("\n\n");
}


/* ------------------------------------------------------------------ */
/*  Phase 4: Handle action path (block manipulation)                   */
/* ------------------------------------------------------------------ */

async function handleActionPath(
  p: ChatSendParams,
  apiBase: string,
  requestBody: any,
  cappedText: string,
  conversationArray: Array<{ role: string; content: string }>,
  promptId: string,
  responseBlockId: string | null,
  statusMsg: string,
): Promise<boolean> {
  const { abortController, state, canvas, typing, identity } = p;
  const signal = abortController.signal;

  state.setChatStatusText(statusMsg);
  try {
    let actionContext: string | undefined;
    const stNow = canvas.getCanvasState();
    const camNow = stNow.camera || { x: 0, y: 0 };
    const vwNow = window.innerWidth || 1280;
    const vhNow = window.innerHeight || 800;
    actionContext = p.context.buildActionLyknChatContext({
      blocks: stNow.blocks as Record<string, any>,
      blockOrder: Array.isArray(stNow.blockOrder) ? stNow.blockOrder : [],
      viewportCenter: { x: (camNow.x || 0) + vwNow / 2, y: (camNow.y || 0) + vhNow / 2 },
      viewportSize: { w: vwNow, h: vhNow },
      focusedBrickIds: Array.isArray(stNow.focusedBrickIds) ? stNow.focusedBrickIds : [],
      wireConnections: Array.isArray(stNow.wireConnections) ? stNow.wireConnections : [],
    });
    const notesPlain = p.context.tiptapJsonToPlainText(p.context.notesContent).trim();
    const wantsNotesAction = /\b(notes?\s*(page|panel|section|pad|area)?)\b/i.test(cappedText)
      && /\b(edit|update|change|modify|write|rewrite|add|append|clear|set|fill|put|type|draft|compose|replace|delete|remove)\b/i.test(cappedText);
    if (notesPlain || wantsNotesAction) {
      actionContext += `\n\n[GRID NOTES — current content]\n${notesPlain || "(empty — no content yet)"}`;
    }

    const actionConvo = conversationArray.slice(-14).map((m) => ({
      ...m,
      content: m.content.length > 6000 ? m.content.slice(0, 6000) + "…" : m.content,
    }));
    const invokeTimeout = setTimeout(() => abortController.abort(), 120000);
    const res = await fetch(`${apiBase}/api/ai/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...requestBody,
        returnActions: true,
        text: cappedText,
        conversation: actionConvo,
        ...(actionContext ? { context: actionContext } : {}),
      }),
      signal,
    });
    clearTimeout(invokeTimeout);
    maybeNotifyModelDowngrade(res);
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const assistantText = p.analysis.sanitizeAssistantResponse(
        String((data as any)?.response || (data as any)?.assistant || "").trim()
      ) || "Done.";
      const actions = Array.isArray((data as any)?.actions) ? (data as any).actions : [];
      if (actions.length) {
        canvas.applyProjectActions(actions);
      }
      await typing.typeResponseIntoChat(promptId, assistantText);
      p.aiThread.push({ role: "assistant", content: assistantText });
      if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
      typing.maybeRunConversationSummary();
      if (identity.userId) { invalidateMemoryCache(); saveExchange(identity.userId, "chat", identity.routeChatId || identity.chatId || null, p.context.titleRef.current || null, cappedText, assistantText); }
      if (responseBlockId) {
        const normalized = canvas.normalizeAiTextForBlock(assistantText);
        const curBlk: any = canvas.getCanvasState().blocks?.[responseBlockId];
        if (curBlk?.data?.userResized) {
          canvas.updateBlock(responseBlockId, { content: normalized });
        } else {
          const size = canvas.calcAiBubbleSize(normalized);
          canvas.updateBlock(responseBlockId, { content: normalized, width: size.width, height: size.height });
        }
      }
      state.setChatStatusText(actions.length ? "Bricks updated" : "Answered");
    } else {
      const errText = AI_TEMPORARY_FAILURE_TEXT;
      state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errText } : m)));
      p.aiThread.push({ role: "assistant", content: errText });
      if (responseBlockId) await typing.typeIntoAiResponseBlock(responseBlockId, errText);
      state.setChatStatusText("Error");
    }
  } catch {
    const errMsg = AI_TEMPORARY_FAILURE_TEXT;
    state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errMsg } : m)));
    if (responseBlockId) await typing.typeIntoAiResponseBlock(responseBlockId, errMsg);
    state.setChatStatusText("Error");
  }
  state.setIsChatLoading(false);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Phase 5: Handle streaming response                                 */
/* ------------------------------------------------------------------ */

/**
 * Mirrors `useChatEngine.extractSourceLinks` but runs against the LIVE
 * streaming buffer so the typewriter view doesn't pre-emptively chop the
 * tail of a reply at the first `\nSources:\n` line. The post-stream
 * `extractSourceLinks` only strips the tail when it actually contains
 * citation links (markdown `[title](url)` or numbered URLs); the streaming
 * view used to strip unconditionally with `replace(/\n+(?:Sources?|References?):?\s*\n[\s\S]*$/i, "")`,
 * which silently truncated long replies the moment the model wrote
 * "Sources:" or "References:" on its own line — even when the next
 * paragraph wasn't a citation list. That looked to the user like the
 * model "got cut off after a few sentences" right up until the
 * post-process commit fired.
 */
function stripTrailingSourcesBlockIfHasLinks(text: string): string {
  const sm = text.match(/\n+(?:Sources?|References?):?[ \t]*\n([\s\S]*?)$/i);
  if (!sm) return text;
  const block = String(sm[1] || "");
  // Markdown citation links — `[title](https://...)`.
  if (/\[[^\]]+\]\(https?:\/\/[^\s)]+\)/.test(block)) {
    return text.slice(0, sm.index ?? 0).trimEnd();
  }
  // Numbered citation list — `1. https://...`.
  if (/(?:^|\n)\s*\d+\.\s*https?:\/\/\S+/.test(block)) {
    return text.slice(0, sm.index ?? 0).trimEnd();
  }
  return text;
}

async function handleStreamingResponse(
  p: ChatSendParams,
  streamRes: Response,
  promptId: string,
  responseBlockId: string | null,
  userText: string,
): Promise<{ accumulated: string; responseBlockId: string | null; servedModel: string | null; generatedImageUrl: string | null; streamedSources: { title: string; url: string }[] }> {
  const { canvas, state, streamRefs } = p;
  const reader = streamRes.body?.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let servedModel: string | null = null;
  // Deep research: the server emits the full source list (every page it
  // searched/read) as an early SSE event, before the report text streams.
  let streamedSources: { title: string; url: string }[] = [];
  // Image generated this turn (lykn_generate_image → done). The URL is
  // appended to the conversation-memory entry (NOT the visible bubble, which
  // renders the image via the artifact card) so the server's follow-up
  // detector can see "the last assistant turn produced an image" and re-force
  // the tool on "do the same but…" edits.
  let generatedImageUrl: string | null = null;
  let firstToken = true;
  let sseBuffer = "";
  let serverErrorMsg = "";
  // Deterministic backstop: only let the agent render a VAULT item as a
  // card in the chat when the user actually asked to see it this turn (or
  // confirmed a surfacing offer). The model is told the same thing in the
  // prompt, but this guarantees no random saved item gets embedded.
  // With Local Mode on, ambiguous "pull in the images" asks are treated as
  // local-file requests — vault cards then need an explicit saved/vault
  // mention.
  const allowVaultSurface = userRequestedVaultSurface(
    userText,
    p.aiThread,
    isLocalModeAvailable() && getLocalModeCached(),
  );
  // Whether to auto-pop the full embedded document reader for a vault item
  // this turn (strict subset of the surface gate above). When false the card
  // still renders; the user pulls it up with one tap.
  const autoOpenVaultViewer = userRequestedVaultDisplay(userText, p.aiThread);
  // 90s inactivity for normal chat. Research reports can pause between
  // continue hops / long writes — match the server's longToolTurn window.
  const STREAM_INACTIVITY_MS = p.composerMode === "research" ? 240000 : 90000;

  if (reader) {
    let inactivityTimer = setTimeout(() => { reader.cancel(); p.abortController.abort(); }, STREAM_INACTIVITY_MS);
    try {
      let stopReading = false;
      while (!stopReading) {
        const { done, value } = await reader.read();
        if (done) {
          sseBuffer += decoder.decode(undefined, { stream: false });
          break;
        }
        clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => { reader.cancel(); p.abortController.abort(); }, STREAM_INACTIVITY_MS);
        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") { stopReading = true; break; }
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              if (import.meta.env.DEV) console.error('SSE error:', parsed.error);
              // Stash the server's message but DO NOT wipe accumulated
              // text. If the user already saw paragraphs render, blowing
              // them away with "something went wrong" is a worse UX than
              // keeping the partial reply (and the server's mid-stream
              // errors are usually transient — overload, downgrade, etc.).
              serverErrorMsg = String(parsed.error || "").trim() || "stream_error";
              continue;
            }
            if (parsed.status) { state.setChatStatusText(String(parsed.status)); continue; }
            if (Array.isArray(parsed.sources)) {
              // Deep-research source list — patch onto the in-flight message
              // immediately so the Studio research rail fills in while the
              // report is still streaming.
              const list = (parsed.sources as any[])
                .filter((s) => s && typeof s.url === "string" && s.url)
                .map((s) => ({ title: String(s.title || "Source"), url: String(s.url) }));
              if (list.length) {
                streamedSources = list;
                state.setChatMessages((prev) =>
                  prev.map((m) => (m.id === promptId ? { ...m, sources: list } : m)),
                );
              }
              continue;
            }
            if (parsed.served_model && typeof parsed.served_model === "string") {
              servedModel = parsed.served_model.trim() || null;
              continue;
            }
            if (parsed.tool_call && typeof parsed.tool_call === "object") {
              // Agent-loop tool call event from server (chat-agent-loop.js).
              // We update the in-flight assistant message's `toolCalls`
              // array in place — the same `id` arrives twice (running →
              // done|error) so we look up by id and patch the existing
              // entry rather than pushing a duplicate.
              const tc = parsed.tool_call as {
                id: string;
                name: string;
                args?: Record<string, unknown>;
                status: "running" | "done" | "error" | "awaiting_client" | "awaiting_approval";
                result?: any;
                error?: string;
                latencyMs?: number;
                localStreamId?: string;
              };
              const now = Date.now();
              // Local Mode: the server can't run file/terminal tools, so it
              // asks the desktop client to. Run it here (with approval for
              // risky actions) and post the result back so the turn resumes.
              const isInFlightLocal =
                tc.status === "awaiting_client" || tc.status === "awaiting_approval";
              if (tc.status === "awaiting_client") {
                void (async () => {
                  const { API_BASE_URL: localApiBase } = await import("@/lib/api-config");
                  await executeAwaitingLocalTool(
                    {
                      id: tc.id,
                      name: tc.name,
                      args: tc.args,
                      localStreamId: tc.localStreamId,
                    },
                    localApiBase,
                  );
                })();
              }
              // When a `lykn_loadNeuron` or `lykn_loadNeurons` call lands
              // with ok:true we want each loaded neuron to render as a
              // real card in the chat (not just as a pill). Build the
              // attachments up front so the setChatMessages updater
              // below can push them onto the same message in a single
              // pass.
              //
              //   • lykn_loadNeuron  → one card from `tc.result`
              //   • lykn_loadNeurons → one card per entry in
              //                        `tc.result.results[]` whose
              //                        per-entry `ok` is true and `kind`
              //                        is recognised. The batch tool
              //                        guarantees each entry is the same
              //                        shape the single tool returns, so
              //                        the card renderer doesn't need to
              //                        branch on which tool fed it.
              const newAttachments: ChatNeuronAttachment[] = [];
              if (
                tc.status === "done"
                && tc.result
                && typeof tc.result === "object"
                && tc.result.ok === true
              ) {
                // Vault items render only when the user asked to see them
                // this turn; belief/fact/concept neurons are never gated.
                const kindAllowed = (kind: string) =>
                  LOAD_NEURON_KINDS.has(kind) && (kind !== "vault" || allowVaultSurface);
                if (
                  tc.name === "lykn_loadNeuron"
                  && kindAllowed(String(tc.result.kind))
                ) {
                  newAttachments.push({
                    id: tc.id,
                    payload: tc.result,
                    addedAt: now,
                    autoOpen:
                      String(tc.result.kind) === "vault" && autoOpenVaultViewer,
                  });
                } else if (
                  tc.name === "lykn_loadNeurons"
                  && Array.isArray(tc.result.results)
                ) {
                  // Suffix the tool_call id with the per-entry index so
                  // the dedupe key stays unique across the batch — every
                  // entry needs its own React key + persistence slot.
                  tc.result.results.forEach((entry: any, i: number) => {
                    if (
                      entry
                      && entry.ok === true
                      && kindAllowed(String(entry.kind))
                    ) {
                      newAttachments.push({
                        id: `${tc.id}#${i}`,
                        payload: entry,
                        addedAt: now,
                        // Only the FIRST vault item in a batch auto-opens, so a
                        // multi-result load doesn't stack modals on top of each
                        // other. The rest render as cards the user can pull up.
                        autoOpen:
                          String(entry.kind) === "vault"
                          && autoOpenVaultViewer
                          && !newAttachments.some(
                            (a) => a.payload?.kind === "vault" && a.autoOpen,
                          ),
                      });
                    }
                  });
                }
              }
              state.setChatMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== promptId) return m;
                  const existing = Array.isArray(m.toolCalls) ? m.toolCalls : [];
                  const idx = existing.findIndex((e) => e.id === tc.id);
                  // Dedupe neuron attachments by id — the same `done`
                  // event won't fire twice in normal flow, but a
                  // defensive check costs nothing and prevents double-
                  // cards if the server ever re-emits. For batch loads
                  // we union all NEW entries that aren't already there.
                  const existingNeurons = Array.isArray(m.aiNeurons) ? m.aiNeurons : [];
                  const haveIds = new Set(existingNeurons.map((n) => n.id));
                  const additions = newAttachments.filter((n) => !haveIds.has(n.id));
                  const neuronsNext = additions.length
                    ? [...existingNeurons, ...additions]
                    : existingNeurons;
                  if (idx === -1) {
                    return {
                      ...m,
                      toolCalls: [
                        ...existing,
                        {
                          id: tc.id,
                          name: tc.name,
                          args: tc.args || {},
                          status: tc.status,
                          result: tc.result,
                          error: tc.error,
                          latencyMs: tc.latencyMs,
                          startedAt: now,
                          finishedAt:
                            tc.status === "running" || isInFlightLocal ? undefined : now,
                        },
                      ],
                      aiNeurons: neuronsNext,
                    };
                  }
                  const merged = [...existing];
                  merged[idx] = {
                    ...merged[idx],
                    name: tc.name || merged[idx].name,
                    args: tc.args || merged[idx].args,
                    status: tc.status,
                    result: tc.result !== undefined ? tc.result : merged[idx].result,
                    error: tc.error !== undefined ? tc.error : merged[idx].error,
                    latencyMs: tc.latencyMs ?? merged[idx].latencyMs,
                    finishedAt:
                      tc.status === "running" || isInFlightLocal
                        ? merged[idx].finishedAt
                        : now,
                  };
                  return { ...m, toolCalls: merged, aiNeurons: neuronsNext };
                }),
              );
              // Give the user a soft status line while tools run so the
              // bubble doesn't sit silent during a multi-hop loop. Narrate
              // the ACTIVITY in plain English ("Building the template…",
              // "Creating the image…") instead of leaking the raw tool name.
              if (tc.status === "running") {
                state.setChatStatusText(toolRunningStatus(tc.name, tc.args));
              } else if (tc.status === "awaiting_client") {
                state.setChatStatusText(toolRunningStatus(tc.name, tc.args));
              } else if (tc.status === "awaiting_approval") {
                state.setChatStatusText("Waiting for your approval…");
              } else if (
                shouldEmitProjectsChanged(tc.name, tc.status, tc.result)
              ) {
                emitProjectsChanged({
                  userId: p.identity.userId,
                  projectId: projectIdFromToolResult(tc.name, tc.result),
                });
              }
              // Remember the image generated this turn for conversation memory
              // (feeds the server's image-follow-up detector next turn).
              if (
                tc.status === "done"
                && tc.name === "lykn_generate_image"
                && tc.result
                && typeof tc.result === "object"
                && typeof (tc.result as { image_url?: string }).image_url === "string"
                && /^https?:\/\//.test((tc.result as { image_url: string }).image_url)
              ) {
                generatedImageUrl = (tc.result as { image_url: string }).image_url;
              }
              // Self-tuning: when the assistant rewrites the user's own custom
              // instructions (tone / behavior), persist the new text into their
              // settings so it sticks, shows up in Settings → Display for manual
              // editing, and rides along on future requests via getAiPrefs.
              if (
                tc.status === "done"
                && tc.name === "lykn_update_assistant_instructions"
                && tc.result
                && typeof tc.result === "object"
                && (tc.result as { ok?: boolean }).ok === true
              ) {
                const r = tc.result as { scope?: string; instructions?: string };
                const text = typeof r.instructions === "string" ? r.instructions.trim() : "";
                if (text) {
                  persistInstructionPrompt(r.scope === "voice" ? "voice" : "chat", text);
                }
              }
              // Settings is a window in the shell, so the server tool only
              // settles which pane was meant — opening it happens here, the
              // same split local_open_path uses to land the user in Files.
              if (
                tc.status === "done"
                && tc.name === "lykn_open_settings"
                && tc.result
                && typeof tc.result === "object"
                && (tc.result as { ok?: boolean }).ok === true
              ) {
                const section = (tc.result as { section?: string }).section;
                openStudioTab("settings", typeof section === "string" ? section : undefined);
              }
              // Same split for the pages and the apps the user built: the
              // server worked out WHICH one was meant, opening it happens here.
              if (
                tc.status === "done"
                && tc.name === "lykn_open_app"
                && tc.result
                && typeof tc.result === "object"
                && (tc.result as { ok?: boolean }).ok === true
              ) {
                const r = tc.result as { kind?: string; id?: string; src?: string | null; label?: string };
                if (typeof r.id === "string" && r.id) {
                  if (r.kind === "installed") void openInstalledApp(r.id);
                  else if (r.kind === "drive") {
                    // A specific file/image/artifact: the universal preview pop.
                    // Opening the Finder window is for the drive or a folder.
                    if (r.id !== "drive") {
                      openLyknMediaPop({
                        type: "vault-note",
                        noteId: r.id,
                        title: typeof r.label === "string" ? r.label : undefined,
                      });
                    } else {
                      openStudioTab("vault", r.src || "/vault?pane=drive");
                    }
                  } else openStudioTab(r.id, r.src || undefined);
                }
              }
              continue;
            }
            if (parsed.t) {
              if (firstToken) {
                // Build / Create turns: don't clobber the cycling "Designing
                // the build…" lane with a generic "Responding…" — the long
                // wait is still ahead (tool args streaming).
                const mode = String(p.composerMode || "");
                if (!mode.startsWith("create:")) {
                  state.setChatStatusText("Responding...");
                }
                firstToken = false;
                streamRefs.streamDisplayedLenRef.current = 0;
                streamRefs.streamTargetTextRef.current = "";
                streamRefs.streamPromptIdRef.current = promptId;
              }
              accumulated += parsed.t;
              // Hide the hidden <learned>/<reason>/<applied> tags from the
              // live streaming view so the user never sees them flicker
              // into the bubble before postProcessResponse strips + parses.
              // ALSO hide any "_…response truncated. Ask 'continue' for the
              // rest._" style note the model may emit at the tail — the
              // system prompt forbids it, but some models still do it, and
              // we'd rather strip it than ever flash it on screen.
              const accumulatedForView = stripToolSyntaxFromStream(
                stripModelTruncationNoteFromStream(
                  stripAppliedTagFromStream(
                    stripLearnedTagFromStream(accumulated),
                  ),
                ),
              );
              const visibleText = stripStreamingActionJson(
                stripTrailingSourcesBlockIfHasLinks(accumulatedForView).replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "")
              ).trimEnd();
              streamRefs.streamTargetTextRef.current = visibleText;
              // The typing animation only ADVANCES `streamDisplayedLenRef`,
              // so if a leaked envelope flashed characters into the bubble
              // and was then stripped (visibleText shrank), the chat message
              // would keep showing the stale leaked prefix until `accumulated`
              // grew long enough for the animation to overwrite it. Snap
              // displayedLen back to the new (shorter) target length and push
              // the corrected partial so the leak vanishes immediately.
              if (streamRefs.streamDisplayedLenRef.current > visibleText.length) {
                streamRefs.streamDisplayedLenRef.current = visibleText.length;
                const pid = streamRefs.streamPromptIdRef.current;
                if (pid) {
                  state.setChatMessages((prev) =>
                    prev.map((m) => (m.id === pid ? { ...m, aiResponse: visibleText } : m)),
                  );
                }
              }
              if (responseBlockId) {
                const normalized = canvas.normalizeAiTextForBlock(visibleText);
                const curBlk: any = canvas.getCanvasState().blocks?.[responseBlockId];
                if (curBlk?.data?.userResized) {
                  canvas.updateBlock(responseBlockId, { content: normalized });
                } else {
                  const size = canvas.calcAiBubbleSize(normalized);
                  canvas.updateBlock(responseBlockId, { content: normalized, width: size.width, height: size.height });
                }
              }
              if (!streamRefs.streamTypingRafRef.current) {
                const typeTick = () => {
                  const target = streamRefs.streamTargetTextRef.current;
                  const cur = streamRefs.streamDisplayedLenRef.current;
                  if (cur < target.length) {
                    const behind = target.length - cur;
                    const step = Math.max(2, Math.min(6, Math.ceil(behind / 6)));
                    streamRefs.streamDisplayedLenRef.current = Math.min(cur + step, target.length);
                    const partial = target.substring(0, streamRefs.streamDisplayedLenRef.current);
                    const pid = streamRefs.streamPromptIdRef.current;
                    if (pid) {
                      state.setChatMessages((prev) =>
                        prev.map((m) => (m.id === pid ? { ...m, aiResponse: partial } : m)),
                      );
                    }
                    if (!streamRefs.chatUserScrolledUpRef.current) {
                      const el = streamRefs.chatScrollRef.current;
                      if (el) {
                        streamRefs.chatProgrammaticScrollRef.current = true;
                        el.scrollTop = el.scrollHeight;
                      }
                    }
                    streamRefs.streamTypingRafRef.current = window.setTimeout(typeTick, 18);
                  } else {
                    streamRefs.streamTypingRafRef.current = null;
                  }
                };
                streamRefs.streamTypingRafRef.current = window.setTimeout(typeTick, 18);
              }
            }
          } catch {}
        }
      }
      // Drain ALL leftover lines from the SSE buffer, not just the last
      // one. Gemini's stream sometimes ends without a trailing newline
      // after the final `data: {...}` event AND can leave more than one
      // un-newlined line in the buffer when the connection closes mid-
      // chunk. Without this, the last sentence(s) of a reply silently
      // disappear and the user sees a cut-off message.
      if (sseBuffer.trim()) {
        for (const line of sseBuffer.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.t) accumulated += parsed.t;
            if (parsed.error && !serverErrorMsg) serverErrorMsg = String(parsed.error || "stream_error");
          } catch {}
        }
        sseBuffer = "";
      }
      // CRITICAL: update the typing animation's target to the full drained
      // accumulated text. Without this, `streamTargetTextRef` would still
      // hold the PRE-drain visible text (last in-stream chunk only). The
      // typing animation runs at ~2-6 chars / 18ms, so for any reply long
      // enough that the animation hasn't caught up at stream-end (which is
      // every reply), the animation keeps firing AFTER post-process commits
      // the full text — and each tick overwrites the committed message
      // with `target.substring(0, displayedLen)`. Animation stops when it
      // catches up to the stale target, leaving the user staring at a
      // truncated reply (the visible bug: "server finished, UI cut off").
      // Updating the target here lets the animation finish typing the
      // ENTIRE final reply, then stop cleanly so the post-process commit
      // sticks.
      try {
        const finalAccumulatedForView = stripToolSyntaxFromStream(
          stripModelTruncationNoteFromStream(
            stripAppliedTagFromStream(
              stripLearnedTagFromStream(accumulated),
            ),
          ),
        );
        const finalVisibleText = finalizeResearchReport(
          stripStreamingActionJson(
            stripTrailingSourcesBlockIfHasLinks(finalAccumulatedForView)
              .replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "")
          ),
        ).trimEnd();
        streamRefs.streamTargetTextRef.current = finalVisibleText;
      } catch {}
    } catch {
      if (!accumulated.trim()) accumulated = AI_TEMPORARY_FAILURE_TEXT;
    } finally {
      clearTimeout(inactivityTimer);
    }
  }

  // If the server reported an error AND we got nothing usable back,
  // surface a friendly message. If we already streamed real content,
  // keep it — the partial reply is far more useful than a generic
  // "something went wrong". The server-side cross-provider chain has
  // already tried every available model on the user's behalf by the
  // time we reach this branch, so the copy never tells the user to
  // switch models — they have nothing further they could pick.
  if (serverErrorMsg && !accumulated.trim()) {
    accumulated = AI_TEMPORARY_FAILURE_TEXT;
  }
  return { accumulated, responseBlockId, servedModel, generatedImageUrl, streamedSources };
}

/* ------------------------------------------------------------------ */
/*  Phase 6: Post-process AI response                                  */
/*  (The action-JSON rescue machinery this phase leans on lives in    */
/*  src/lib/ai/actionJsonRescue.ts.)                                   */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Learn-a-fact helpers live in src/lib/ai/learnedTag.ts. The        */
/*  primary tag-emit + fallback classifier wiring lives in            */
/*  postProcessResponse below.                                         */
/* ------------------------------------------------------------------ */


async function postProcessResponse(
  p: ChatSendParams,
  aiTextRaw: string,
  promptId: string,
  responseBlockId: string | null,
  youtubeGrounding: string,
  youtubeTranscriptSource: string,
  asksAboutVideo: boolean,
  cappedText: string,
  servedModel: string | null = null,
  generatedImageUrl: string | null = null,
  streamedSources: { title: string; url: string }[] = [],
): Promise<void> {
  const { analysis, postProcessing, state, canvas, typing, identity } = p;

  // === LEARN-A-FACT — parse the hidden <learned>/<reason> tag pair the
  // model may have emitted at the very end of its reply. The tag is the
  // signal that the user just shared something personal (positive OR
  // negative) and we need to mint a brand-new neuron in their synthesis
  // layer. We strip the tag from the visible text BEFORE the rest of the
  // post-processing pipeline runs so no downstream extractor (sources,
  // YouTube, media pull, AI connections, conversation memory, etc.) sees
  // it. The POST to /api/learned runs async — it must not block the chat
  // bubble from rendering. When it resolves we patch `factNeuron` onto the
  // message so the "Neuron created" pill appears below the AI response.
  const learned = parseLearnedTag(aiTextRaw);
  // === BELIEF-WINDOW APPLIED — parse + strip the optional <applied> tag
  // BEFORE the visible reply is sanitized. The model may emit BOTH a
  // <learned>/<updated> tag AND an <applied> tag in the same reply; the
  // applied tag is independent of the learned-fact tag and does not
  // need any post-processing pipeline awareness beyond strip-and-post.
  const applied = parseAppliedTag(aiTextRaw);
  // Strip the hidden tags AND repair any dangling clause they may have
  // amputated when the model started a tag mid-sentence (e.g.
  // "...right now. We <learned>..." → "...right now. We"). finalizeVisibleReply
  // pops the broken tail back to the previous sentence boundary.
  // We also strip any self-emitted "_…response truncated. Ask 'continue'
  // for the rest._" / "[response truncated]" style note BEFORE
  // finalizeVisibleReply runs so the dangling-tail repair acts on the
  // model's last real sentence rather than on the truncation marker.
  const aiTextWithoutLearnedTag = finalizeVisibleReply(
    finalizeResearchReport(
      stripModelTruncationNote(
        stripToolSyntaxFromFinal(
          stripAppliedTagFromFinal(stripLearnedTagsFromFinal(aiTextRaw)),
        ),
      ),
    ),
  );

  let aiText = analysis.sanitizeAssistantResponse(aiTextWithoutLearnedTag.trim());

  // Rescue any block-creation markup the AI may have leaked into the chat text
  // (legacy `[CREATE_BLOCK:...]`, ```json fences, or bare action JSON). The
  // helper applies recovered actions to the grid AND strips them from the chat.
  aiText = rescueInlineBlockMarkup(aiText, canvas.applyProjectActions);
  const hasYTG = Boolean(String(youtubeGrounding || "").trim() && String(youtubeGrounding || "").trim() !== "(none)");
  if (asksAboutVideo && hasYTG) {
    const fallback = analysis.buildDirectVideoAnswerFromGrounding(youtubeGrounding);
    if (fallback && (!aiText || analysis.looksLikeDeflectingQuestion(aiText))) aiText = fallback;
  }
  // Defensive logging + better fallback: if every stripping pass (learned
  // tag, sanitize, action rescue) ate the whole reply, the model probably
  // emitted ONLY hidden tags / ONLY action JSON, or the stream returned
  // no text at all. The vague "Could you rephrase?" fallback hid the real
  // issue; log the raw text in dev so we can see exactly what came back.
  if (!aiText && import.meta.env.DEV) {
    const rawSummary = String(aiTextRaw || "").trim();
    const rawPreview = rawSummary.slice(0, 200).replace(/\s+/g, " ");
    console.warn(
      `[chatSendOrchestrator] visible reply empty after post-processing. ` +
        `Raw=${rawSummary.length} chars: "${rawPreview}${rawSummary.length > 200 ? "…" : ""}". ` +
        `Likely: model emitted only hidden tags / action JSON, or stream returned no text.`,
    );
  }
  // Reaching this fallback means the server's cross-provider chain ran to
  // completion AND every provider returned zero visible text. (The server
  // already retries gemini → openai → claude → grok internally.) Telling
  // the user to "switch models" here is misleading because every model has
  // already been tried; surface the centralized transient-failure copy
  // instead so they know to just retry the same prompt in a moment.
  const finalText = aiText || AI_TEMPORARY_FAILURE_TEXT;
  const { connections: aiConnections, cleanText: textWithoutConnections } = postProcessing.extractAiConnections(finalText);
  if (aiConnections.length > 0) {
    const boardConns = aiConnections.filter((c) => c.sourceType === "board");
    const mediaConns = aiConnections.filter((c) => c.sourceType === "media");
    if (boardConns.length > 0) {
      state.setConnectionCards(boardConns);
      state.setShowConnectionCard(true);
    }
    if (mediaConns.length > 0) {
      const cached = p.context.getCachedWorkspaceSummary()?.full || "";
      const resolved = mediaConns.map((mc) => {
        const m = cached.match(new RegExp(`"${mc.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*\\(id=([^)]+)\\)`));
        return m?.[1] ? { title: mc.title, reason: mc.reason, noteId: m[1] } : null;
      }).filter(Boolean) as Array<{ title: string; reason: string; noteId: string }>;
      if (resolved.length > 0) {
        state.setMediaSuggestions(resolved);
        state.setSelectedMediaIds(new Set());
        state.setShowMediaSuggestion(true);
      }
    }
  }
  const textAfterTags = await postProcessing.extractAndApplyTagActions(textWithoutConnections);
  const { cleanText: displayText, sources: extractedSources } = postProcessing.extractSourceLinks(textAfterTags);
  // Deep research streams its full source list (every page searched/read)
  // as an early SSE event — richer than the trailing "Sources:" block the
  // model writes. Keep the streamed list first, then any extra citations.
  const sources = (() => {
    if (!streamedSources.length) return extractedSources;
    const seen = new Set(streamedSources.map((s) => s.url));
    return [...streamedSources, ...extractedSources.filter((s) => !seen.has(s.url))];
  })();
  const ytResult = await postProcessing.extractAndEmbedYouTubeUrls(displayText, promptId, responseBlockId);
  const textAfterYt = ytResult.cleanText || displayText;
  const mediaResult = await postProcessing.extractAndEmbedMediaItems(textAfterYt, responseBlockId);
  // Always prefer mediaResult.cleanText whenever it differs from the input.
  // The previous `pulled > 0` gate left raw [PULL_MEDIA:...] markers visible
  // to the user when every pull failed (deleted note / RLS / broken URL),
  // breaking the prompt-level "hidden from user" contract.
  const finalDisplayText = mediaResult.cleanText !== textAfterYt ? mediaResult.cleanText : textAfterYt;
  const webLinks = postProcessing.extractWebLinksFromText(finalDisplayText);
  // Cancel any pending rAF commit BEFORE we set the final text. Otherwise
  // the queued frame fires with a stale `streamTargetTextRef` and overwrites
  // our final commit with the pre-cleanup in-stream view (which is how a
  // user sees "server finished but UI is cut off"). We also sync the target
  // ref to the final text so any in-flight frame that already started can't
  // introduce regressions.
  if (p.streamRefs.streamTypingRafRef.current) {
    clearTimeout(p.streamRefs.streamTypingRafRef.current);
    p.streamRefs.streamTypingRafRef.current = null;
  }
  p.streamRefs.streamTargetTextRef.current = finalDisplayText;
  p.streamRefs.streamDisplayedLenRef.current = finalDisplayText.length;
  const replyModel = servedModel || identity.selectedModel || null;
  const completedAt = new Date().toISOString();
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? {
    ...m,
    aiResponse: finalDisplayText,
    aiModel: replyModel || undefined,
    aiCompletedAt: completedAt,
    sources,
    aiYouTubeUrls: ytResult.urls.length ? ytResult.urls : undefined,
    aiWebLinks: webLinks.length ? webLinks : undefined,
  } : m)));
  // Push the post-cleanup display text into conversation memory so future
  // turns and saved exchanges don't reference internal markers / source tags.
  // A generated image gets its markdown line appended HERE (memory only — the
  // visible bubble renders it as a card): the server's follow-up detector
  // reads it from `conversation` to re-force lykn_generate_image when the
  // next message is a tweak ("same thing but…", "make it darker").
  const threadContent = generatedImageUrl
    ? `${finalDisplayText}\n\n![Generated image](${generatedImageUrl})`
    : finalDisplayText;
  p.aiThread.push({ role: "assistant", content: threadContent, model: replyModel || undefined, at: completedAt });
  if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
  typing.maybeRunConversationSummary();
  if (identity.userId) { invalidateMemoryCache(); saveExchange(identity.userId, "chat", identity.routeChatId || identity.chatId || null, p.context.titleRef.current || null, cappedText, finalDisplayText); }

  // === AUTO-NAME — fire-and-forget after any user→assistant turn while
  // the chat is still using the default placeholder title.
  //
  // Generates a 2-5 word title from this exchange and writes it through
  // to `lykn_chats.title` server-side, then surfaces the new title in
  // every mounted view (sidebar, mobile sheet, toolbar) via the existing
  // `lyknchat_renamed` + `lykinsai_chats_changed` events.
  //
  // Gates:
  //   • signed-in user (guests have no DB row)
  //   • we have a real board id (route or persisted)
  //   • title is still the default — never clobber a manual rename
  //   • haven't already named this board in this session (server is the
  //     real source of truth, but skipping the round-trip is free)
  //   • haven't already burned the per-board retry budget — caps the
  //     "user keeps chatting with title stuck on New Chat" case at a few
  //     extra attempts instead of hitting /api/ai/name-chat on every send
  //
  // Note we intentionally don't require `aiThread.length === 2` like an
  // earlier revision did — that branch only fired on a brand-new chat's
  // very first reply, so any chat created before this feature shipped
  // (or any first-attempt that lost a race / hit a network blip) was
  // stuck on "New Chat" forever even as the user kept chatting.
  //
  // Errors are silent — a missed title just means the chat keeps the
  // "New Chat" placeholder, which is exactly what it shows today.
  maybeAutoNameChat({
    chatId: identity.routeChatId || identity.chatId,
    userId: identity.userId,
    currentTitle: p.context.titleRef.current,
    userMessage: cappedText,
    assistantReply: finalDisplayText,
  });
  if (responseBlockId) {
    const normalized = canvas.normalizeAiTextForBlock(finalDisplayText);
    const curBlk: any = canvas.getCanvasState().blocks?.[responseBlockId];
    if (curBlk?.data?.userResized) {
      canvas.updateBlock(responseBlockId, { content: normalized });
    } else {
      const size = canvas.calcAiBubbleSize(normalized);
      canvas.updateBlock(responseBlockId, { content: normalized, width: size.width, height: size.height });
    }
    if (sources.length > 0) postProcessing.attachSourcesToBlock(responseBlockId, sources);
  }
  state.setChatStatusText(mediaResult.pulled > 0 ? "Media added to board" : ytResult.urls.length ? "Video embedded" : aiConnections.length > 0 ? "Connection found" : "Answered");

  // Fire the live-learn upsert AFTER the chat has rendered the visible
  // reply, so the "Neuron created" pill shows up as a delightful surprise
  // a beat later rather than blocking the bubble. Guests (no userId) skip
  // this entirely — the landing-prototype path owns its own client-side
  // neuron creation.
  //
  // Two paths, mutually exclusive per turn:
  //
  //   • PRIMARY (learned !== null) — model emitted <fact_confirm> /
  //     <learned> / <updated>; POST propose or /api/learned.
  //
  //   • FALLBACK (learned === null) — the chat model forgot to tag.
  //     POST /api/learned/auto classifier as a soft learn (no confirm chip).
  //
  // Confirm-chip budget: at most one *new* Yes/Edit/No prompt every
  // CONFIRM_CHIP_COOLDOWN_TURNS user turns. Replacements (contradictions)
  // always bypass the budget — stale ✓ facts are worse than a second chip.
  const CONFIRM_CHIP_COOLDOWN_TURNS = 4;
  const confirmChipOnCooldown = (() => {
    const msgs = p.chatMessages || [];
    let userTurnsSeen = 0;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.id === promptId) continue;
      if (m?.role !== "user") continue;
      userTurnsSeen += 1;
      if (m.factNeuron?.needsConfirm) return true;
      if (userTurnsSeen >= CONFIRM_CHIP_COOLDOWN_TURNS) break;
    }
    return false;
  })();

  if (learned && identity.userId) {
    void (async () => {
      try {
        const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
        // Contradictions / refinements of WHO_I_AM always go through the
        // confirm chip (propose + supersedes) so Yes retires the old claim.
        const replaceText =
          learned.mode === "update"
            ? learned.previousText
            : learned.mode === "confirm"
              ? learned.previousText || undefined
              : undefined;
        const isReplace = Boolean(replaceText);
        const wantsConfirm = learned.mode === "confirm" || isReplace;
        // Soft-learn instead of chip when budget is spent (non-replace only).
        const needsConfirm = wantsConfirm && (isReplace || !confirmChipOnCooldown);
        const result = await postLearnedFact(apiBase, {
          text: learned.text,
          kind: learned.kind,
          reason: learned.reason,
          sourceId: identity.routeChatId || identity.chatId || "live_chat",
          sourceMessageId: promptId,
          needsConfirm,
          replacesText: replaceText,
        });
        if (!result) return;
        // Confirm chip always surfaces. Soft learn pills only for new/update.
        if (!result.needsConfirm && !result.isNew && !result.isUpdate) return;
        state.setChatMessages((prev) => prev.map((m) => (m.id === promptId
          ? { ...m, factNeuron: result }
          : m)));
      } catch {
        // Never let a learn miss break the chat surface.
      }
    })();
  } else if (!learned && identity.userId) {
    void (async () => {
      try {
        const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
        const result = await postAutoLearnedFact(apiBase, {
          // cappedText is the post-truncation user message the chat send
          // pipeline actually used; finalDisplayText is the cleaned
          // assistant reply (no source tags, no internal markers). The
          // classifier needs both to judge personal disclosure in
          // context.
          userMessage: cappedText,
          assistantReply: finalDisplayText,
          sourceId: identity.routeChatId || identity.chatId || "auto",
        });
        if (!result || (!result.isNew && !result.isUpdate)) return;
        state.setChatMessages((prev) => prev.map((m) => (m.id === promptId
          ? { ...m, factNeuron: result }
          : m)));
      } catch {
        // Classifier failures are silent — the next turn will try again.
      }
    })();
  }

  // === BELIEF-WINDOW APPLIED — independent of the learned-fact path.
  // If the model emitted an <applied rule_id="..."> tag, post it to the
  // server which validates ownership + active status before recording an
  // attribution. Failures here MUST NOT break the chat — a missed
  // attribution just means the audit trail for this turn is missing,
  // not that the user gets a broken bubble.
  if (applied && identity.userId) {
    void (async () => {
      try {
        const { API_BASE_URL: apiBase } = await import("@/lib/api-config");
        const attribution = await postAppliedAttribution(apiBase, {
          ruleId: applied.ruleId,
          messageId: promptId,
          reason: applied.reason,
          surface: "chat",
          surfaceId: identity.routeChatId || identity.chatId || undefined,
        });
        if (!attribution) return;
        state.setChatMessages((prev) => prev.map((m) => (m.id === promptId
          ? { ...m, appliedAttribution: attribution }
          : m)));
      } catch {
        // Honest by default: a missed attribution just means no Why pill.
      }
    })();
  }

  // Persist the finished turn promptly so switching devices (phone → laptop)
  // doesn't depend on the 30s autosave interval or a tab-background event.
  if (identity.userId) {
    setTimeout(() => window.dispatchEvent(new Event("lyknchat_flush_save")), 300);
  }
}

/* ------------------------------------------------------------------ */
/*  Main orchestrator                                                  */
/* ------------------------------------------------------------------ */

export async function orchestrateChatSend(p: ChatSendParams): Promise<void> {
  const {
    text, promptId, sentAttachments, brickActionData,
    abortController, identity, context, youtube, analysis, canvas, state, streamRefs, typing,
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

  const attachmentContext = buildAttachmentContext(sentAttachments);

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

  const recentThread = p.aiThread.slice(-16);
  const history = recentThread
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.length > 1200 ? m.content.slice(0, 1200) + "…" : m.content}`)
    .join("\n");

  const conversationArray: Array<{ role: string; content: string; model?: string; at?: string }> = [];
  for (const cm of p.chatMessages) {
    if (cm.role === "user" && cm.content) {
      conversationArray.push({ role: "user", content: cm.content, at: cm.createdAt });
      if (cm.aiResponse) {
        conversationArray.push({
          role: "assistant",
          content: cm.aiResponse,
          model: cm.aiModel,
          at: cm.aiCompletedAt || cm.createdAt,
        });
      }
    } else if (cm.role !== "user" && cm.content) {
      conversationArray.push({ role: "assistant", content: cm.content, model: cm.aiModel, at: cm.aiCompletedAt });
    }
  }
  conversationArray.push({ role: "user", content: cappedText, at: new Date().toISOString() });

  const { API_BASE_URL: apiBase } = await import("@/lib/api-config");

  /* Phase 1: transcribe attachments */
  await transcribeAttachments(sentAttachments, apiBase, isBrickAction, signal, state.setChatStatusText);

  /* Phase 2: canvas context + YouTube enrichment
   *
   * The canvas / grid surface is gone. `buildLyknChatContext()` returns
   * "" and `getCanvasState()` is an empty stub, so the grid-iterating
   * paths below (focused-block YouTube, notes-panel injection,
   * vision-image scanning, action-path) stay skipped.
   */
  let canvasContext = context.buildLyknChatContext();
  const canvasState = canvas.getCanvasState();
  const canvasHasContent = Object.keys(canvasState.blocks || {}).length > 0;

  const earlyFocused: string[] =
    canvasHasContent && Array.isArray(canvasState.focusedBrickIds)
      ? canvasState.focusedBrickIds
      : [];

  if (canvasHasContent) {
    for (const fid of earlyFocused) {
      const blk: any = canvas.getCanvasState().blocks?.[fid];
      if (!blk) continue;
      const t = String(blk.type || "").toLowerCase();
      const m = String(blk.mode || blk.data?.mode || "").toLowerCase();
      if (t !== "youtube" && !(t === "create" && m === "video")) continue;
      const vid = String(blk.videoId || blk.data?.videoId || "");
      const rawUrl = String(blk.url || blk.data?.url || "");
      const resolvedVid = vid || extractYouTubeVideoId(rawUrl) || "";
      if (!resolvedVid) continue;
      const cached = youtube.youtubeTranscriptCache[resolvedVid];
      if (cached?.transcript) {
        const preview = cached.transcript.length > 2000 ? cached.transcript.slice(0, 2000) + "…" : cached.transcript;
        const isDesc = cached.source === "description_fallback";
        const label = isDesc
          ? `[FOCUSED VIDEO DESCRIPTION — id=${fid} videoId=${resolvedVid} — This is the video's description/metadata, NOT a transcript of its spoken audio]`
          : `[FOCUSED VIDEO TRANSCRIPT — id=${fid} videoId=${resolvedVid}]`;
        canvasContext += `\n\n${label}\n${cached.title || "YouTube Video"}\n${preview}`;
      }
    }

    const notesText = context.tiptapJsonToPlainText(context.notesContent).trim();
    if (notesText) canvasContext += `\n\n[GRID NOTES]\n${notesText}`;
  }

  const kbText = context.getKnowledgeBaseContext();

  const hasFocusedVideo = canvasHasContent && earlyFocused.some((fid) => {
    const blk: any = canvas.getCanvasState().blocks?.[fid];
    if (!blk) return false;
    const t = String(blk.type || "").toLowerCase();
    const m = String(blk.mode || blk.data?.mode || "").toLowerCase();
    return t === "youtube" || t === "video" || (t === "create" && (m === "video" || m === "audio"));
  });

  const asksAboutVideo = !isBrickAction && analysis.isVideoQuestion(text);
  const needsFullTranscript = asksAboutVideo || isBrickAction || hasFocusedVideo;

  const { youtubeGrounding, youtubeTranscriptSource } = await fetchYouTubeGrounding(p, apiBase, isBrickAction, earlyFocused, hasFocusedVideo);
  const uploadedVideoTranscript = await transcribeUploadedVideos(p, apiBase, earlyFocused, needsFullTranscript);

  /* Phase 3: build request body */
  const videoTranscriptBlock = youtubeGrounding
    ? (youtubeTranscriptSource === "description_fallback"
        ? `[VIDEO DESCRIPTION ONLY — The text below is the video's description metadata, NOT a transcript of its spoken audio. We attempted to transcribe the audio (captions + Whisper speech-to-text) but could not obtain a transcript — likely because the audio could not be downloaded from YouTube for this video. Do NOT treat this as what was said in the video. If the user asks to transcribe or asks what was said, explain that you attempted automatic transcription but it failed for this video, and you only have the description.]\n${youtubeGrounding}`
        : youtubeGrounding.includes("Full transcript:")
          ? `[VIDEO TRANSCRIPT — Use this to answer the user's question about the video. Do NOT say you cannot access the video. The transcript below IS the video's content.]\n${youtubeGrounding}`
          : `YouTube transcript context:\n${youtubeGrounding}`)
    : "";
  const uploadedVideoBlock = uploadedVideoTranscript
    ? `[UPLOADED VIDEO TRANSCRIPT — Use this to answer the user's question about the video. The transcript below IS the video's spoken content.]\n${uploadedVideoTranscript.trim()}`
    : "";
  const prompt = [
    history ? `Conversation so far:\n${history}` : "",
    videoTranscriptBlock,
    uploadedVideoBlock,
    `Latest user message:\n${(text.length > 3000 ? text.slice(0, 3000) + "…" : text)}${attachmentContext}`,
  ].filter(Boolean).join("\n\n");

  const attachedImageUrls = sentAttachments
    .filter((a) => a.type?.toLowerCase() === "image" && a.url)
    .map((a) => a.url);
  if (brickActionData?.imageUrl && !attachedImageUrls.includes(brickActionData.imageUrl)) {
    attachedImageUrls.push(brickActionData.imageUrl);
  }

  // Structured metadata for the binary attachments on THIS turn, so a tool
  // (lykn_uploadToProject) can save the dragged-in file to the vault and
  // cluster it into a project ("upload this image to my X project"). We
  // deliberately do NOT re-serialise image data URLs here — image bytes
  // already ship in `imageUrls`, so each image attachment carries an
  // `imageIndex` the server uses to recover the data URL from that array
  // when no durable `storagePath` exists yet. Non-image binaries (pdf,
  // file, video, audio) reference their storagePath / signed url instead.
  let _imgCursor = 0;
  const turnAttachments = sentAttachments
    .map((a) => {
      const t = (a.type || "").toLowerCase();
      const isImg = t === "image" && !!a.url;
      const meta: Record<string, unknown> = {
        type: t,
        name: a.name || a.vaultTitle || "attachment",
        ...(a.mime ? { mime: a.mime } : {}),
        ...(a.storagePath ? { storagePath: a.storagePath } : {}),
        ...(a.storageBucket ? { storageBucket: a.storageBucket } : {}),
        ...(a.url && !a.url.startsWith("data:") ? { url: a.url } : {}),
      };
      if (isImg) meta.imageIndex = _imgCursor++;
      const isBinary = t === "image" || t === "pdf" || t === "file" || t === "video" || t === "audio";
      return { isBinary, meta };
    })
    .filter((x) => x.isBinary)
    .map((x) => x.meta)
    .slice(0, 8);

  if (signal.aborted) return;
  state.setChatStatusText("");
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));

  // With the canvas surface unplugged there are no focused bricks and no
  // board images to scan for vision. Both loops are no-ops on an empty
  // store but skipping them entirely keeps the request build path tight.
  const st = canvasHasContent ? canvas.getCanvasState() : { blocks: {}, blockOrder: [], focusedBrickIds: [], camera: { x: 0, y: 0 } } as any;
  const hasFocusedBricks = canvasHasContent && (st.focusedBrickIds || []).length > 0;
  const focusedIds: string[] = canvasHasContent && Array.isArray(st.focusedBrickIds) ? st.focusedBrickIds : [];

  const isImgBlock = (blk: any) => blk?.type === "image" || (blk?.type === "create" && (blk.mode === "image" || blk.mode === "generated"));
  const getImgSrc = (blk: any) => {
    const src = String(blk?.src || blk?.data?.src || "").trim();
    return (src && (src.startsWith("http") || src.startsWith("data:image/"))) ? src : "";
  };

  if (canvasHasContent) {
    const visionImageUrls: string[] = [];
    for (const fid of focusedIds) {
      const blk = st.blocks?.[fid];
      if (!isImgBlock(blk)) continue;
      const src = getImgSrc(blk);
      if (src && !visionImageUrls.includes(src)) visionImageUrls.push(src);
    }

    const MAX_VISION_IMAGES = 8;
    if (visionImageUrls.length < MAX_VISION_IMAGES) {
      const cam = st.camera || { x: 0, y: 0 };
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const cx = (cam.x || 0) + vw / 2;
      const cy = (cam.y || 0) + vh / 2;
      const allIds = Array.isArray(st.blockOrder) ? st.blockOrder : [];
      const focusedSet = new Set(focusedIds);
      const boardImages = allIds
        .filter((id: string) => !focusedSet.has(id) && st.blocks?.[id] && isImgBlock(st.blocks[id]))
        .map((id: string) => {
          const blk = st.blocks[id];
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

    for (const url of visionImageUrls) {
      if (!attachedImageUrls.includes(url)) attachedImageUrls.push(url);
    }
  }

  const hasVideoTranscript = Boolean(
    (youtubeGrounding && youtubeGrounding.includes("Full transcript:")) || uploadedVideoTranscript
  );
  const textForServer = hasVideoTranscript ? prompt.slice(0, 16000) : cappedText;
  const recentConvo = conversationArray.slice(-8).map((m) => ({
    ...m,
    content: m.content.length > 1500 ? m.content.slice(0, 1500) + "…" : m.content,
  }));
  const truncatedConversation = p.conversationSummary
    ? [{
        role: "system",
        content: [
          "[WORKING_MEMORY]",
          "Short-lived thread state (not durable User Facts). Prefer this for continuity in THIS chat — goals, open questions, decisions, next step.",
          p.conversationSummary,
        ].join("\n"),
      }, ...recentConvo]
    : recentConvo;

  const skipMemoryPrefetch =
    !identity.userId ||
    cappedText.trim().length < 12 ||
    /^(?:hi|hello|hey|yo|sup|thanks|thank you|ok|okay|sure|yes|no|yep|nope|got it|cool|nice|great|bye)[\s!.?…]*$/i.test(
      cappedText.trim(),
    );
  const memoryText = skipMemoryPrefetch
    ? ""
    : await getMemoryForPrompt(
        identity.userId,
        identity.routeChatId || identity.chatId || null,
        cappedText,
      );
  // Files live in the Vault Finder: [AI DRIVE] is sent below, Mac folders
  // via local_* when Local Mode is on. The old vault_items / connected-apps
  // dump is not injected.

  // Trim the request body to only what the server needs. With the canvas
  // surface unplugged we never ship a `[CONTEXT]` block (canvasContext is
  // always ""), `hasFocusedBricks` is always false, and there's no point
  // serialising either across the wire — both branches on the server then
  // skip context-sized prompt budgets and stay on the lighter chat path.
  const trimmedCanvasContext = (canvasContext || "").slice(0, 14000);
  const customModelId = CUSTOM_MODELS_ENABLED
    ? identity.customModelId ?? (identity.userId ? loadActiveCustomModelId() : null)
    : null;
  // Local Mode must be read from main over IPC at send time: the module-level
  // cache starts false and primes asynchronously, so the first send after a
  // window load would silently drop the flag if we trusted the cache alone.
  const localModeOn = isLocalModeAvailable() ? await refreshLocalMode() : false;
  // Apps the user built in LYKN live in the local store on their machine, so
  // the server only knows they exist because we say so. Names and ids only —
  // enough for lykn_open_app to match "open my workout tracker" to a real app.
  const installedApps = (await listInstalledApps())
    .slice(0, 60)
    .map((app) => ({ id: app.id, name: app.name }));
  // The applications on this Mac. Whether "pull up Spotify" should open the app
  // or the website depends on whether this person has it, which only their
  // machine knows — so the answer comes from here rather than a guess.
  const macApps = (await macAppNames()).slice(0, 200);
  // AI Drive — the artifacts and images LYKN has made for them. Those are
  // things they built too, and "open the dashboard I made" only resolves if
  // the model has been told the dashboard is in there. The totals ride along
  // separately: only the newest are named, and a model that sees a short list
  // and no count will report the list as the count.
  const aiDrive = await listAiDrive(identity.userId);
  const requestBody = {
    model: identity.selectedModel,
    ...(customModelId ? { customModelId } : {}),
    prompt: prompt.slice(0, 16000),
    text: textForServer,
    intent: "ask",
    knowledgeBase: (kbText || "").slice(0, identity.projectId ? 4000 : 2000),
    conversation: truncatedConversation,
    conversationMemory: memoryText || undefined,
    workspaceContext: "",
    projectId: identity.projectId,
    ...(identity.scopedProjectId ? { scopedProjectId: identity.scopedProjectId } : {}),
    ...(identity.scopedProjectName ? { scopedProjectName: identity.scopedProjectName } : {}),
    chatId: identity.routeChatId || identity.chatId || undefined,
    skipWebSearch: hasVideoTranscript,
    // Chat-bar "+" capability modes — the server forces the matching tool /
    // web search deterministically for this turn (see /api/ai/stream).
    // Explicit composer mode so the server can lock exclusive lanes
    // (research must not auto-infer Create just because the topic says "pitch").
    ...(p.composerMode && p.composerMode !== "none"
      ? { composerMode: p.composerMode }
      : {}),
    // Studio mode session (Build / Imagine / Research): mode system prompt
    // for the server's [ACTIVE_MODE] section — every turn in the session.
    ...(p.modeInstructions && p.modeInstructions.trim()
      ? { modeInstructions: p.modeInstructions.trim().slice(0, 2000) }
      : {}),
    ...(p.composerMode === "web" ? { forceWebSearch: true } : {}),
    ...(p.composerMode === "research"
      ? {
          forceWebSearch: true,
          deepResearch: true,
          researchSourcePref: String(p.researchSourcePref || "all")
            .trim()
            .toLowerCase()
            .slice(0, 32),
        }
      : {}),
    ...(p.composerMode === "image" ? { forceImage: true } : {}),
    // "+" → Create submenu: build a rich artifact (deck, study guide, chart…).
    ...(typeof p.composerMode === "string" && p.composerMode.startsWith("create:")
      ? { forceArtifact: true, artifactType: p.composerMode.slice("create:".length) }
      : {}),
    // Artifact open in the preview popup — let the server refine it in place.
    ...(p.activeArtifact ? { activeArtifact: p.activeArtifact } : {}),
    // Opt this turn into the agent loop (chat-agent-loop.js). Authenticated
    // chat path only — the model can call the in-app tool whitelist
    // (mcp-tools/chatTools.js) to read/write synthesis-layer state via
    // OpenAI function-calling, and the SSE stream interleaves tool_call
    // events with text deltas. Server forces an OpenAI tool-capable model
    // when this is on; X-Tool-Route header announces the swap.
    useTools: true,
    // Local Mode — when the user flipped the Vault switch AND we're in the
    // desktop shell, offer file/terminal tools that execute on their machine.
    ...(localModeOn ? { localMode: true } : {}),
    // The user's IANA timezone (browser-resolved) so the server can give the
    // model the user's LOCAL "now" + offset. Without this, scheduling tools
    // (createEvent/createReminder) land events at the wrong time because the
    // model has no idea what timezone the user means by "3pm".
    timezone: resolveLocalTimezone(),
    ...(trimmedCanvasContext ? { context: trimmedCanvasContext } : {}),
    ...(hasFocusedBricks ? { hasFocusedBricks: true } : {}),
    ...(attachedImageUrls.length ? { imageUrls: attachedImageUrls } : {}),
    ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
    ...(installedApps.length ? { installedApps } : {}),
    ...(macApps.length ? { macApps } : {}),
    ...(aiDrive.items.length
      ? {
          aiDrive: aiDrive.items,
          aiDriveTotals: {
            artifacts: aiDrive.artifacts,
            images: aiDrive.images,
            complete: aiDrive.complete,
          },
        }
      : {}),
    ...getAiPrefs(),
  };

  /* Phase 4: action path check
   *
   * The block / brick / grid action path is permanently disabled — the
   * canvas surface is not part of the current product, so every chat
   * turn flows through the streaming chat path below. The previous
   * implementation kept ~50 lines of intent regexes + a dead
   * `if (false && ...)` branch alive "in case the grid comes back",
   * but they bloated the file, ran on every chat send, and shipped a
   * confusing `wantsActionPath` API surface. If/when the canvas is
   * re-enabled, the action path lives intact in `handleActionPath()` /
   * `buildActionLyknChatContext()` and can be re-wired here behind a
   * single feature flag — we just stop pre-classifying intents.
   */
  let responseBlockId: string | null = null;

  /* Phase 5: streaming or invoke */
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
  let notifiedModelDowngrade = false;
  // 402 = the free credit allowance is spent (or a lapsed subscription).
  // Not transient — retrying or falling back to /api/ai/invoke would hit the
  // same wall, so we surface the upgrade message instead of the generic
  // connection-trouble text.
  let paywallText: string | null = null;
  const fetchChatStream = async (): Promise<Response | null> => {
    try {
      const timeout = setTimeout(() => abortController.abort(), 120000);
      const res = await fetch(`${apiBase}/api/ai/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        signal,
      });
      clearTimeout(timeout);
      if (res.status === 402) {
        const data = await res.json().catch(() => ({}));
        paywallText =
          String((data as { error?: string })?.error || "").trim() ||
          "You've used all your free credits. Upgrade your plan to keep going.";
        return null;
      }
      // The server swaps to a cheaper model for out-of-tier requests; tell
      // the user so they know why they got a different answer than expected.
      // Only once per turn — a silent retry shouldn't double-toast.
      if (!notifiedModelDowngrade) {
        maybeNotifyModelDowngrade(res);
        notifiedModelDowngrade = true;
      }
      if (res.ok && res.headers.get("content-type")?.includes("text/event-stream")) {
        return res;
      }
      return null;
    } catch {
      return null;
    }
  };
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

  let streamResponse = await fetchChatStream();
  if (!streamResponse && !paywallText && !signal.aborted) {
    // The first attempt can land exactly while the backend is restarting
    // (dev-server watch reboots, deploys). An immediate retry would hit the
    // same dead socket — a short pause rides out the gap before giving up
    // to the non-streaming fallback.
    state.setChatStatusText("Reconnecting…");
    await new Promise((r) => setTimeout(r, 2500));
    streamResponse = await fetchChatStream();
  }

  if (!streamResponse && paywallText) {
    const finalText = paywallText;
    state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
    p.aiThread.push({ role: "assistant", content: finalText });
    if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
    state.setChatStatusText("Answered");
    return;
  }

  if (streamResponse) {
    let streamResult = await handleStreamingResponse(p, streamResponse, promptId, responseBlockId, text);
    let accumulated = streamResult.accumulated;
    responseBlockId = streamResult.responseBlockId;

    for (
      let attempt = 0;
      attempt < MAX_STREAM_RETRIES
        && streamReturnedNoUsableText(accumulated)
        && !signal.aborted;
      attempt++
    ) {
      resetStreamTypingState();
      state.setChatStatusText("Reconnecting…");
      const retryResponse = await fetchChatStream();
      if (!retryResponse) break;
      streamResult = await handleStreamingResponse(p, retryResponse, promptId, responseBlockId, text);
      accumulated = streamResult.accumulated;
      responseBlockId = streamResult.responseBlockId;
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
      responseBlockId,
      youtubeGrounding,
      youtubeTranscriptSource,
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
      if (responseBlockId) await typing.typeIntoAiResponseBlock(responseBlockId, finalText);
      state.setChatStatusText("Answered");
      return;
    }
    let invokeAiText = String(data?.response || data?.answer || data?.text || "").trim();
    await typing.typeResponseIntoChat(promptId, analysis.sanitizeAssistantResponse(invokeAiText) || "I'm not sure how to answer that. Could you rephrase?");
    await postProcessResponse(
      p,
      invokeAiText,
      promptId,
      responseBlockId,
      youtubeGrounding,
      youtubeTranscriptSource,
      asksAboutVideo,
      cappedText,
      identity.selectedModel,
    );
  }
}
