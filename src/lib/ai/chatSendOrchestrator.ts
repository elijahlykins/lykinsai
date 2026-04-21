import { extractYouTubeVideoId } from "@/canvas/utils/youtube";
import { getAiPrefs } from "@/lib/ai-prefs";
import { CONTEXT_BUDGETS } from "@/lib/ai/promptBuilder";
import { saveExchange, getMemoryForPrompt, invalidateMemoryCache } from "@/lib/conversationMemory";
import { fetchNotesForVaultAi, buildVaultDetailForGridAi, type VaultAiNoteRow } from "@/lib/vault/vaultContentsForAi";
import { toast } from "@/components/ui/use-toast";

// Show a one-shot toast when the server downgrades the model. The server
// annotates responses with `X-Model-Downgraded: from->to` whenever the caller
// requests a model locked behind their plan. Toast once per session per pair
// to avoid spamming chatty users.
const notifiedDowngrades = new Set<string>();
function maybeNotifyModelDowngrade(res: Response | null | undefined) {
  if (!res) return;
  const header = res.headers.get("x-model-downgraded");
  if (!header || notifiedDowngrades.has(header)) return;
  notifiedDowngrades.add(header);
  const [from, to] = header.split("->");
  try {
    toast({
      title: "Using a free model for now",
      description: `${from?.trim() || "That model"} needs a higher plan — we used ${to?.trim() || "a free model"} instead.`,
    });
  } catch { /* toast unavailable */ }
}

/* ------------------------------------------------------------------ */
/*  Shared types re-exported so callers don't need OmniaGrid           */
/* ------------------------------------------------------------------ */

export type PromptMessage = {
  id: string;
  role: "user";
  content: string;
  aiResponse?: string;
  aiImageUrl?: string;
  aiImageStoragePath?: string;
  aiYouTubeUrls?: { url: string; videoId: string }[];
  aiWebLinks?: string[];
  sources?: { title: string; url: string }[];
  kind?: "prompt";
  attachments?: FocusedChatAttachment[];
};

export type FocusedChatAttachment = {
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

export type CreateAction =
  | { type: "create_sheet"; content?: string; title?: string }
  | { type: "create_spreadsheet"; rows?: number; cols?: number; cells?: Record<string, string>; cells2d?: string[][] }
  | { type: "create_table"; headers?: string[]; rows?: string[][]; cols?: number }
  | { type: "create_list"; listType?: "todo" | "bulleted" | "numbered"; items?: string[] }
  | { type: "create_design_board"; board?: any; title?: string; seedText?: string }
  | { type: "create_code_block"; language?: string; content?: string }
  | { type: "create_universal_block"; universalType?: string; name?: string; data?: Record<string, unknown> }
  | { type: "create_youtube_block"; url?: string; title?: string }
  | { type: "create_heading"; level?: 1 | 2 | 3; content?: string }
  | { type: "create_h1"; content?: string }
  | { type: "create_h2"; content?: string }
  | { type: "create_h3"; content?: string }
  | { type: "create_quote"; content?: string }
  | { type: "create_callout"; content?: string }
  | { type: "create_text"; content?: string; format?: string }
  | { type: "create_brick"; content?: string; format?: string }
  | { type: "create_text_block"; content?: string; format?: string }
  | { type: "create_card"; content?: string }
  | { type: "create_toggle"; content?: string }
  | { type: "create_task_board"; title?: string; columns?: Array<{ title: string; tasks?: string[] }> }
  | { type: "create_kanban"; title?: string; columns?: Array<{ title: string; tasks?: string[] }> }
  | { type: "create_media"; url?: string; mode?: string; name?: string }
  | { type: "create_embed"; url?: string; name?: string }
  | { type: "create_image_block"; url?: string; src?: string }
  | { type: "create_video_block"; url?: string }
  | { type: "organize_grid"; strategy?: "grid" | "column" | "vertical"; columns?: number }
  | { type: "auto_organize"; strategy?: string }
  | { type: "move_block"; blockId: string; x?: number; y?: number; dx?: number; dy?: number }
  | { type: "move_blocks"; moves: Array<{ blockId: string; x?: number; y?: number; dx?: number; dy?: number }> }
  | { type: "resize_block"; blockId: string; width?: number; height?: number }
  | { type: "update_text_block"; blockId: string; content?: string; append?: string; data?: Record<string, any> }
  | { type: "update_block"; blockId: string; content?: string; append?: string; data?: Record<string, any> }
  | { type: "edit_block"; blockId: string; content?: string; append?: string; data?: Record<string, any> }
  | { type: "update_list"; blockId: string; items?: string[]; append?: string[]; listType?: string }
  | { type: "update_spreadsheet"; blockId: string; cells?: Record<string, string>; cells2d?: string[][]; startRow?: number; startCol?: number }
  | { type: "update_code_block"; blockId: string; content?: string; append?: string; language?: string }
  | { type: "create_database_relation"; fromDatabaseName?: string; toDatabaseName?: string; relationType?: "one-to-one" | "one-to-many" | "many-to-many"; rollup?: { property?: string; aggregation?: "sum" | "count" | "average" } }
  | { type: "delete_block"; blockId?: string; blockIds?: string[] }
  | { type: "color_block"; blockId?: string; blockIds?: string[]; brickColor?: string; textColor?: string }
  | { type: "connect_blocks"; fromId: string; toId: string; fromSide?: string; toSide?: string }
  | { type: "add_wire"; fromId: string; toId: string; fromSide?: string; toSide?: string }
  | { type: "remove_connection"; fromId?: string; toId?: string; wireId?: string }
  | { type: "disconnect_blocks"; fromId?: string; toId?: string }
  | { type: "update_notes"; content: string | object }
  | { type: "append_notes"; content: string | object }
  | { type: string; [key: string]: any };

export type OrchestratorResult = {
  response: string;
  followUpQuestions: string[];
  actions: CreateAction[];
  requiresClarification: boolean;
  groundingSummary?: string;
};

/* ------------------------------------------------------------------ */
/*  Dependency interfaces                                              */
/* ------------------------------------------------------------------ */

export interface ChatSendIdentity {
  selectedModel: string;
  boardId: string | null;
  routeBoardId: string | undefined;
  projectId: string | null;
  userId: string | undefined;
}

export interface ChatSendContext {
  buildCanvasContext: () => string;
  buildActionCanvasContext: (opts: {
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
  sentAttachments: FocusedChatAttachment[];
  brickActionData: { imageUrl?: string; videoId?: string } | null;
  chatMessages: PromptMessage[];
  aiThread: Array<{ role: "user" | "assistant"; content: string }>;
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

function buildAttachmentContext(sentAttachments: FocusedChatAttachment[]): string {
  if (!sentAttachments.length) return "";
  return "\n\n[Attached content]\n" + sentAttachments.map((a) => {
    const t = (a.type || "").toLowerCase();
    const label = a.name || a.vaultTitle || "Untitled";
    const parts: string[] = [];
    if (a.vaultContent) parts.push(String(a.vaultContent).slice(0, 1500));
    if (a.pdfText) parts.push(String(a.pdfText).slice(0, 1500));
    if (a.extractedText) parts.push(String(a.extractedText).slice(0, 1500));
    if (a.transcript) parts.push(String(a.transcript).slice(0, 8000));
    if (t === "vault" || t === "note") {
      return `${t === "note" ? "Note" : "Vault"} "${label}": ${parts.join("\n") || "(empty)"}`;
    }
    if (t === "pdf") return `PDF "${label}": ${parts.join("\n") || `(PDF at ${a.url})`}`;
    if (t === "document") return `Document "${label}": ${parts.join("\n") || "(could not extract text)"}`;
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
  }).join("\n\n");
}

/* ------------------------------------------------------------------ */
/*  Phase 1: Transcribe attachments                                    */
/* ------------------------------------------------------------------ */

async function transcribeAttachments(
  sentAttachments: FocusedChatAttachment[],
  apiBase: string,
  isBrickAction: boolean,
  signal: AbortSignal,
  onStatus: (s: string) => void,
): Promise<void> {
  for (const att of sentAttachments) {
    if (att.transcript) continue;
    const attType = (att.type || "").toLowerCase();

    if (attType === "youtube" && att.videoId) {
      try {
        if (signal.aborted) break;
        onStatus(isBrickAction ? "Transcribing video..." : "Fetching video transcript...");
        const attTimeout = setTimeout(() => { /* caller owns abort */ }, 120000);
        const tRes = await fetch(`${apiBase}/api/youtube/transcript?id=${encodeURIComponent(att.videoId)}`, { signal });
        clearTimeout(attTimeout);
        if (tRes.ok) {
          const tData = await tRes.json() as any;
          const t = String(tData?.transcript || "").trim();
          const tSource = String(tData?.source || "").toLowerCase();
          if (t && tSource === "description_fallback") {
            if (!signal.aborted) {
              onStatus("No captions — transcribing audio...");
              const retryRes = await fetch(`${apiBase}/api/youtube/transcript?id=${encodeURIComponent(att.videoId)}&retryWhisper=1`, { signal }).catch(() => null);
              if (retryRes && retryRes.ok) {
                const retryData = await retryRes.json() as any;
                const retrySource = String(retryData?.source || "").toLowerCase();
                const retryT = String(retryData?.transcript || "").trim();
                if (retryT && retrySource !== "description_fallback") {
                  att.transcript = retryT;
                } else {
                  att.transcript = `[VIDEO DESCRIPTION — not a transcript of spoken audio]\n${t}`;
                }
              } else {
                att.transcript = `[VIDEO DESCRIPTION — not a transcript of spoken audio]\n${t}`;
              }
            }
          } else if (t) {
            att.transcript = t;
          }
        }
      } catch { /* continue without transcript */ }
      continue;
    }

    if (attType === "video" || attType === "audio") {
      try {
        onStatus(`Transcribing ${att.name || attType}...`);
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
        } else if (att.url && att.url.startsWith("http")) {
          const blobResp = await fetch(att.url, { signal });
          if (blobResp.ok) {
            const blob = await blobResp.blob();
            const mimeType = att.mime || blob.type || (attType === "audio" ? "audio/webm" : "video/mp4");
            const ext = mimeType.split("/")[1] || (attType === "audio" ? "webm" : "mp4");
            formData.append("file", blob, att.name || `upload.${ext}`);
          }
        }
        if (formData.has("file") && !signal.aborted) {
          const wRes = await fetch(`${apiBase}/api/whisper/transcribe`, { method: "POST", body: formData, signal });
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
}

/* ------------------------------------------------------------------ */
/*  Phase 2: YouTube grounding for board videos                        */
/* ------------------------------------------------------------------ */

async function fetchYouTubeGrounding(
  p: ChatSendParams,
  apiBase: string,
  isBrickAction: boolean,
  earlyFocusedIds: string[],
  hasFocusedVideo: boolean,
): Promise<{ youtubeGrounding: string; youtubeTranscriptSource: string }> {
  const { text, abortController, youtube, analysis, state, context } = p;
  const signal = abortController.signal;
  const asksAboutVideo = !isBrickAction && analysis.isVideoQuestion(text);
  const needsFullTranscript = asksAboutVideo || isBrickAction || hasFocusedVideo;

  const boardVideos = youtube.getAllYouTubeBlocks();
  const attachedYouTubeVideos = p.sentAttachments
    .filter((a) => a.type?.toLowerCase() === "youtube" && a.videoId)
    .map((a) => ({ videoId: a.videoId!, url: a.url, title: a.name || `YouTube ${a.videoId}` }));
  const seen = new Set<string>();
  const allYouTubeVideos: Array<{ videoId: string; url: string; title: string }> = [];

  if (hasFocusedVideo) {
    const st = p.canvas.getCanvasState();
    for (const fid of earlyFocusedIds) {
      const blk: any = st.blocks?.[fid];
      if (!blk) continue;
      const t = String(blk.type || "").toLowerCase();
      const m = String(blk.mode || blk.data?.mode || "").toLowerCase();
      if (t !== "youtube" && !(t === "create" && m === "video")) continue;
      const vid = String(blk.videoId || blk.data?.videoId || "");
      const rawUrl = String(blk.url || blk.data?.url || "");
      const resolvedVid = vid || extractYouTubeVideoId(rawUrl) || "";
      if (resolvedVid && !seen.has(resolvedVid)) {
        seen.add(resolvedVid);
        allYouTubeVideos.push({
          videoId: resolvedVid,
          url: rawUrl || `https://www.youtube.com/watch?v=${resolvedVid}`,
          title: String(blk.data?.title || blk.data?.name || "").trim(),
        });
      }
    }
  }

  for (const v of [...attachedYouTubeVideos, ...boardVideos]) {
    if (seen.has(v.videoId)) continue;
    seen.add(v.videoId);
    allYouTubeVideos.push(v);
  }

  let youtubeGrounding = "";
  let youtubeTranscriptSource = "";

  if (needsFullTranscript && allYouTubeVideos.length > 0 && !signal.aborted) {
    const targetVideo = allYouTubeVideos[0];
    state.setChatStatusText("Fetching video transcript...");
    try {
      const tTimeout = setTimeout(() => { if (!signal.aborted) abortController.abort(); }, 120000);
      let tRes = await fetch(
        `${apiBase}/api/youtube/transcript?id=${encodeURIComponent(targetVideo.videoId)}`,
        { signal }
      ).catch(() => null);
      clearTimeout(tTimeout);
      let tJson: any = tRes && tRes.ok ? await tRes.json().catch(() => ({})) : {};
      let transcriptSource = String(tJson?.source || "").toLowerCase();

      let whisperWasAttempted = Boolean(tJson?.whisperAttempted);
      if (transcriptSource === "description_fallback" && !signal.aborted) {
        state.setChatStatusText("No captions found — transcribing video audio...");
        const retryTimeout = setTimeout(() => { if (!signal.aborted) abortController.abort(); }, 120000);
        const retryRes = await fetch(
          `${apiBase}/api/youtube/transcript?id=${encodeURIComponent(targetVideo.videoId)}&retryWhisper=1`,
          { signal }
        ).catch(() => null);
        clearTimeout(retryTimeout);
        if (retryRes && retryRes.ok) {
          const retryJson: any = await retryRes.json().catch(() => ({}));
          const retrySource = String(retryJson?.source || "").toLowerCase();
          whisperWasAttempted = whisperWasAttempted || Boolean(retryJson?.whisperAttempted);
          if (retrySource !== "description_fallback" && String(retryJson?.transcript || "").trim()) {
            tJson = retryJson;
            transcriptSource = retrySource;
          }
        }
      }

      youtubeTranscriptSource = transcriptSource;
      const fullTranscript = String(tJson?.transcript || "").trim();
      if (fullTranscript) {
        youtube.youtubeTranscriptCache[targetVideo.videoId] = {
          fetchedAt: Date.now(),
          title: targetVideo.title || `YouTube ${targetVideo.videoId}`,
          url: targetVideo.url,
          transcript: fullTranscript,
          segments: Array.isArray(tJson?.segments) ? tJson.segments : [],
          source: transcriptSource,
        };
        const safeTranscript =
          fullTranscript.length > 12000
            ? fullTranscript.slice(0, 10000) + "\n...[transcript truncated — " + Math.round(fullTranscript.length / 1000) + "k total chars]"
            : fullTranscript;
        if (transcriptSource === "description_fallback") {
          const whisperNote = whisperWasAttempted
            ? "Audio transcription was attempted using Whisper speech-to-text but the audio could not be downloaded from YouTube."
            : "No audio transcription was attempted.";
          youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\n${whisperNote}\nVideo description (this is NOT a transcript of spoken audio — it is only the video's description/metadata):\n${safeTranscript}`;
          state.setChatStatusText("Transcription failed — only description available...");
        } else {
          youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId}\nFull transcript:\n${safeTranscript}`;
          state.setChatStatusText("Transcript ready — generating response...");
        }
      } else {
        const whisperNote = whisperWasAttempted ? " Audio transcription was attempted but failed." : "";
        state.setChatStatusText("No transcript available — answering from metadata...");
        youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(No transcript or description available.${whisperNote})`;
      }
    } catch {
      if (!signal.aborted) {
        state.setChatStatusText("Transcript fetch failed — answering from metadata...");
        youtubeGrounding = `Video: ${targetVideo.title || targetVideo.videoId} (${targetVideo.url})\n(Transcript fetch failed)`;
      }
    }
  } else if (!isBrickAction && allYouTubeVideos.length > 0 && !signal.aborted) {
    const hasAnyCachedTranscript = allYouTubeVideos.some(
      (v) => youtube.youtubeTranscriptCache[v.videoId]?.transcript,
    );
    if (hasAnyCachedTranscript) {
      state.setChatStatusText("Analyzing visible YouTube videos...");
      youtubeGrounding = await youtube.buildYouTubeGrounding(apiBase, text, signal);
    }
  }

  return { youtubeGrounding, youtubeTranscriptSource };
}

/* ------------------------------------------------------------------ */
/*  Phase 3: Whisper for uploaded video/audio canvas blocks            */
/* ------------------------------------------------------------------ */

async function transcribeUploadedVideos(
  p: ChatSendParams,
  apiBase: string,
  earlyFocusedIds: string[],
  needsFullTranscript: boolean,
): Promise<string> {
  const signal = p.abortController.signal;
  if (signal.aborted) return "";

  const focusedSet = new Set(earlyFocusedIds);
  const st = p.canvas.getCanvasState();
  const allBlockIds: string[] = Array.isArray(st.blockOrder) ? st.blockOrder : [];
  const scanIds = needsFullTranscript
    ? [...earlyFocusedIds, ...allBlockIds.filter((id: string) => !focusedSet.has(id))]
    : earlyFocusedIds;
  const transcribedUrls = new Set<string>();
  const MAX_WHISPER_BLOCKS = 3;
  let whisperCount = 0;
  let uploadedVideoTranscript = "";

  for (const fid of scanIds) {
    if (signal.aborted || whisperCount >= MAX_WHISPER_BLOCKS) break;
    const blk: any = st.blocks?.[fid];
    if (!blk) continue;
    const t = String(blk.type || "").toLowerCase();
    const m = String(blk.mode || blk.data?.mode || "").toLowerCase();
    const isUploadedVideo = (t === "create" && m === "video") || t === "video";
    const isUploadedAudio = (t === "create" && m === "audio") || t === "audio";
    if (!isUploadedVideo && !isUploadedAudio) continue;
    const vid = String(blk.videoId || blk.data?.videoId || "");
    const rawUrl = String(blk.url || blk.data?.url || "");
    const resolvedVid = vid || extractYouTubeVideoId(rawUrl) || "";
    if (resolvedVid) continue;
    if (!rawUrl || transcribedUrls.has(rawUrl)) continue;
    transcribedUrls.add(rawUrl);
    try {
      p.state.setChatStatusText("Transcribing uploaded video...");
      const resp = await fetch(rawUrl, { signal });
      if (!resp.ok) continue;
      const blob = await resp.blob();
      const mimeType = String(blk.data?.mime || blk.mime || blob.type || "video/mp4");
      const ext = mimeType.split("/")[1] || "mp4";
      const fileName = String(blk.data?.name || `video.${ext}`);
      const formData = new FormData();
      formData.append("file", blob, fileName);
      const wRes = await fetch(`${apiBase}/api/whisper/transcribe`, {
        method: "POST",
        body: formData,
        signal,
      });
      if (wRes.ok) {
        const wData = await wRes.json();
        const tr = String(wData?.transcript || "").trim();
        if (tr) {
          whisperCount++;
          const safeTr = tr.length > 10000
            ? tr.slice(0, 10000) + "\n...[transcript truncated]"
            : tr;
          uploadedVideoTranscript += `\nUploaded video "${fileName}":\n${safeTr}`;
        }
      }
    } catch { /* continue without transcript */ }
  }
  return uploadedVideoTranscript;
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
    actionContext = p.context.buildActionCanvasContext({
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
      if (identity.userId) { invalidateMemoryCache(); saveExchange(identity.userId, "grid", identity.routeBoardId || identity.boardId || null, p.context.titleRef.current || null, cappedText, assistantText); }
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
      const errText = "This model isn\u2019t working properly right now \u2014 try another model.";
      state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: errText } : m)));
      p.aiThread.push({ role: "assistant", content: errText });
      if (responseBlockId) await typing.typeIntoAiResponseBlock(responseBlockId, errText);
      state.setChatStatusText("Error");
    }
  } catch {
    const errMsg = "This model isn\u2019t working properly right now \u2014 try another model.";
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

/* ------------------------------------------------------------------ */
/*  Guest (logged-out) chat flow                                       */
/*  Skips workspace/memory/tool routing; streams Gemini Flash only.    */
/* ------------------------------------------------------------------ */
async function runGuestChat(
  p: ChatSendParams,
  promptId: string,
  cappedText: string,
): Promise<void> {
  const { state, streamRefs, abortController } = p;
  const signal = abortController.signal;

  state.setChatStatusText("Thinking…");
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));

  const history: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const cm of p.chatMessages) {
    if (cm.role === "user" && cm.content) {
      history.push({ role: "user", content: cm.content });
      if (cm.aiResponse) history.push({ role: "assistant", content: cm.aiResponse });
    } else if (cm.role !== "user" && cm.content) {
      history.push({ role: "assistant", content: cm.content });
    }
  }
  // Drop the most recent user entry — it's the live prompt we're about to send.
  if (history.length && history[history.length - 1].role === "user") history.pop();

  const { API_BASE_URL: apiBase } = await import("@/lib/api-config");

  let streamResponse: Response | null = null;
  try {
    const timeout = setTimeout(() => abortController.abort(), 90_000);
    streamResponse = await fetch(`${apiBase}/api/ai/stream-guest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: cappedText, history }),
      signal,
    });
    clearTimeout(timeout);
  } catch {
    streamResponse = null;
  }

  if (!streamResponse || !streamResponse.ok) {
    let msg = "This demo is having trouble right now — please try again, or sign in for full access.";
    if (streamResponse?.status === 429) {
      msg = "You've hit the free preview limit for now — sign in to keep chatting.";
    }
    state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: msg } : m)));
    p.aiThread.push({ role: "assistant", content: msg });
    state.setChatStatusText("Answered");
    return;
  }

  const { accumulated } = await handleStreamingResponse(p, streamResponse, promptId, null, cappedText);

  if (streamRefs.streamTypingRafRef.current) {
    clearTimeout(streamRefs.streamTypingRafRef.current);
    streamRefs.streamTypingRafRef.current = null;
  }
  if (streamRefs.streamPromptIdRef.current && streamRefs.streamDisplayedLenRef.current < streamRefs.streamTargetTextRef.current.length) {
    state.setChatMessages((prev) => prev.map((m) => (m.id === streamRefs.streamPromptIdRef.current ? { ...m, aiResponse: streamRefs.streamTargetTextRef.current } : m)));
  }
  streamRefs.streamTargetTextRef.current = "";
  streamRefs.streamDisplayedLenRef.current = 0;
  streamRefs.streamPromptIdRef.current = null;

  const finalText = accumulated || "This demo is having trouble right now — please try again.";
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
  p.aiThread.push({ role: "assistant", content: finalText });
  if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
  state.setChatStatusText("Answered");
}

async function handleStreamingResponse(
  p: ChatSendParams,
  streamRes: Response,
  promptId: string,
  responseBlockId: string | null,
  userText: string,
): Promise<{ accumulated: string; responseBlockId: string | null }> {
  const { canvas, state, streamRefs } = p;
  const reader = streamRes.body?.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let firstToken = true;
  let sseBuffer = "";
  const isVideoReq = /\b(?:generate|create|make|produce|render)\b.{0,20}\b(?:video|clip|animation|footage|cinematic)\b/i.test(userText) || /\b(?:animate|film)\b.{0,30}\b(?:me|a|an|the|of|for)\b/i.test(userText);
  const STREAM_INACTIVITY_MS = isVideoReq ? 11 * 60 * 1000 : 60000;

  if (reader) {
    let inactivityTimer = setTimeout(() => { reader.cancel(); p.abortController.abort(); }, STREAM_INACTIVITY_MS);
    try {
      while (true) {
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
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) {
              if (import.meta.env.DEV) console.error('SSE error:', parsed.error);
              accumulated = "Something went wrong. Please try again.";
              break;
            }
            if (parsed.status) { state.setChatStatusText(String(parsed.status)); continue; }
            if (parsed.image) {
              state.setChatStatusText("Image generated");
              const imageUrl = String(parsed.image);
              state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: `[Generated Image]`, aiImageUrl: imageUrl } : m)));
              {
                const stImg = canvas.getCanvasState();
                const gImg = Math.max(1, Math.floor(stImg.gridSize || 24));
                let imgX: number, imgY: number;
                if (responseBlockId && stImg.blocks?.[responseBlockId]) {
                  imgX = stImg.blocks[responseBlockId].x ?? 100;
                  imgY = stImg.blocks[responseBlockId].y ?? 100;
                  try { canvas.deleteBlock(responseBlockId); } catch {}
                } else {
                  const imgPos = findSmartPlacementForImage(stImg, gImg);
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
              uploadAiImageToStorage(p, promptId, imageUrl);
              accumulated = `[Generated Image](${imageUrl})`;
              break;
            }
            if (parsed.t) {
              if (firstToken) {
                state.setChatStatusText("Responding...");
                firstToken = false;
                streamRefs.streamDisplayedLenRef.current = 0;
                streamRefs.streamTargetTextRef.current = "";
                streamRefs.streamPromptIdRef.current = promptId;
              }
              accumulated += parsed.t;
              const visibleText = accumulated.replace(/\n+(?:Sources?|References?):?\s*\n[\s\S]*$/i, "").replace(/\s*\[TAG_NOTES:[^\]]*\]/g, "").trimEnd();
              streamRefs.streamTargetTextRef.current = visibleText;
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
                    if (pid) state.setChatMessages((prev) => prev.map((m) => (m.id === pid ? { ...m, aiResponse: partial } : m)));
                    if (!streamRefs.chatUserScrolledUpRef.current) {
                      const el = streamRefs.chatScrollRef.current;
                      if (el) { streamRefs.chatProgrammaticScrollRef.current = true; el.scrollTop = el.scrollHeight; }
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
      if (sseBuffer.trim()) {
        const trimmed = sseBuffer.trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          if (payload !== "[DONE]") {
            try { const parsed = JSON.parse(payload); if (parsed.t) accumulated += parsed.t; } catch {}
          }
        }
      }
    } catch {
      if (!accumulated.trim()) accumulated = "This model isn\u2019t working properly right now \u2014 try another model.";
    } finally {
      clearTimeout(inactivityTimer);
    }
  }
  return { accumulated, responseBlockId };
}

function findSmartPlacementForImage(st: any, g: number) {
  const allBlocks = Object.values(st.blocks || {}).filter(Boolean) as any[];
  const cam = st.camera || { x: 0, y: 0, zoom: 1 };
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  const cx = Math.round(((cam.x || 0) + vw / 2 - g * 6) / g) * g;
  const cy = Math.round(((cam.y || 0) + vh / 2 - g * 6) / g) * g;
  const overlaps = (px: number, py: number) =>
    allBlocks.some((r: any) => px < (r.x || 0) + (r.width || g) + g && px + g * 12 > (r.x || 0) - g && py < (r.y || 0) + (r.height || g) + g && py + g * 12 > (r.y || 0) - g);
  if (!overlaps(cx, cy)) return { x: cx, y: cy };
  for (let r = g; r < Math.max(vw, vh); r += g) {
    for (const [dx, dy] of [[0, -r], [r, 0], [0, r], [-r, 0]]) {
      const px = Math.round((cx + dx) / g) * g;
      const py = Math.round((cy + dy) / g) * g;
      if (!overlaps(px, py)) return { x: px, y: py };
    }
  }
  return { x: cx, y: cy + g * 14 };
}

function uploadAiImageToStorage(p: ChatSendParams, promptId: string, imageUrl: string) {
  const userId = p.identity.userId;
  const supabase = p.supabaseClient;
  if (!userId) return;
  (async () => {
    try {
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) return;
      const blob = await imgRes.blob();
      const imgExt = blob.type?.includes("png") ? "png" : "jpg";
      const imgPath = `${userId}/chat-images/${promptId}.${imgExt}`;
      const { error: upErr } = await supabase.storage.from("user-files").upload(imgPath, blob, { cacheControl: "3600", upsert: true });
      if (upErr) return;
      const { data: signed } = await supabase.storage.from("user-files").createSignedUrl(imgPath, 60 * 60 * 24 * 7);
      if (signed?.signedUrl) {
        p.state.setChatMessages((prev: PromptMessage[]) => prev.map((m: PromptMessage) => (m.id === promptId ? { ...m, aiImageUrl: signed.signedUrl, aiImageStoragePath: imgPath } : m)));
      }
    } catch { /* non-critical */ }
  })();
}

/* ------------------------------------------------------------------ */
/*  Phase 6: Post-process AI response                                  */
/* ------------------------------------------------------------------ */

function rescueInlineBlockMarkup(text: string, applyActions: (actions: CreateAction[]) => any): string {
  const re = /\[CREATE_BLOCK:\s*(\{[^]*?\})\s*\]/g;
  const rescued: CreateAction[] = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const obj = JSON.parse(m[1]);
      const bType = String(obj.type || "text").toLowerCase();
      const content = String(obj.content || "").trim();
      const actionType = bType === "heading" || bType === "h1" ? "create_heading"
        : bType === "h2" ? "create_h2" : bType === "h3" ? "create_h3"
        : bType === "quote" || bType === "callout" ? "create_quote"
        : bType === "list" || bType === "todo" ? "create_list"
        : bType === "code" ? "create_code_block"
        : bType === "sheet" || bType === "paper" ? "create_sheet"
        : bType === "spreadsheet" ? "create_spreadsheet"
        : bType === "table" ? "create_table"
        : "create_text";
      const action: any = { type: actionType, content };
      if (obj.position?.x != null) action.x = Number(obj.position.x);
      if (obj.position?.y != null) action.y = Number(obj.position.y);
      if (bType === "heading" || bType === "h1") action.level = 1;
      if (bType === "h2") action.level = 2;
      if (bType === "h3") action.level = 3;
      rescued.push(action);
    } catch { /* skip unparseable */ }
  }
  if (rescued.length) {
    applyActions(rescued);
  }
  return text
    .replace(/\[CREATE_BLOCK:\s*\{[^]*?\}\s*\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function postProcessResponse(
  p: ChatSendParams,
  aiTextRaw: string,
  promptId: string,
  responseBlockId: string | null,
  youtubeGrounding: string,
  youtubeTranscriptSource: string,
  asksAboutVideo: boolean,
  cappedText: string,
): Promise<void> {
  const { analysis, postProcessing, state, canvas, typing, identity } = p;

  let aiText = analysis.sanitizeAssistantResponse(aiTextRaw.trim());

  // Rescue any [CREATE_BLOCK:...] markup the AI may have put in the response text
  if (aiText.includes("[CREATE_BLOCK:")) {
    aiText = rescueInlineBlockMarkup(aiText, canvas.applyProjectActions);
  }
  const hasYTG = Boolean(String(youtubeGrounding || "").trim() && String(youtubeGrounding || "").trim() !== "(none)");
  if (asksAboutVideo && hasYTG) {
    const fallback = analysis.buildDirectVideoAnswerFromGrounding(youtubeGrounding);
    if (fallback && (!aiText || analysis.looksLikeDeflectingQuestion(aiText))) aiText = fallback;
  }
  const finalText = aiText || "I'm not sure how to answer that. Could you rephrase?";
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
  const { cleanText: displayText, sources } = postProcessing.extractSourceLinks(textAfterTags);
  const ytResult = await postProcessing.extractAndEmbedYouTubeUrls(displayText, promptId, responseBlockId);
  const textAfterYt = ytResult.cleanText || displayText;
  const mediaResult = await postProcessing.extractAndEmbedMediaItems(textAfterYt, responseBlockId);
  const finalDisplayText = mediaResult.pulled > 0 ? mediaResult.cleanText : textAfterYt;
  const webLinks = postProcessing.extractWebLinksFromText(finalDisplayText);
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalDisplayText, sources, aiYouTubeUrls: ytResult.urls.length ? ytResult.urls : undefined, aiWebLinks: webLinks.length ? webLinks : undefined } : m)));
  p.aiThread.push({ role: "assistant", content: textAfterTags });
  if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
  typing.maybeRunConversationSummary();
  if (identity.userId) { invalidateMemoryCache(); saveExchange(identity.userId, "grid", identity.routeBoardId || identity.boardId || null, p.context.titleRef.current || null, cappedText, textWithoutConnections); }
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
  const attachmentContext = buildAttachmentContext(sentAttachments);

  p.aiThread.push({ role: "user", content: cappedText + (attachmentContext ? attachmentContext.slice(0, 1000) : "") });
  if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);

  // Guest (logged-out) path — bypass all workspace/memory/action routing and
  // stream a lightweight Gemini-only response. No attachments, no tools.
  if (!identity.userId) {
    await runGuestChat(p, promptId, cappedText);
    return;
  }

  const recentThread = p.aiThread.slice(-16);
  const history = recentThread
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.length > 1200 ? m.content.slice(0, 1200) + "…" : m.content}`)
    .join("\n");

  const conversationArray: Array<{ role: string; content: string }> = [];
  for (const cm of p.chatMessages) {
    if (cm.role === "user" && cm.content) {
      conversationArray.push({ role: "user", content: cm.content });
      if (cm.aiResponse) conversationArray.push({ role: "assistant", content: cm.aiResponse });
    } else if (cm.role !== "user" && cm.content) {
      conversationArray.push({ role: "assistant", content: cm.content });
    }
  }
  conversationArray.push({ role: "user", content: cappedText });

  const { API_BASE_URL: apiBase } = await import("@/lib/api-config");

  /* Phase 1: transcribe attachments */
  await transcribeAttachments(sentAttachments, apiBase, isBrickAction, signal, state.setChatStatusText);

  /* Phase 2: canvas context + YouTube enrichment */
  let canvasContext = context.buildCanvasContext();

  const earlyFocused: string[] = (() => {
    const s = canvas.getCanvasState();
    return Array.isArray(s.focusedBrickIds) ? s.focusedBrickIds : [];
  })();

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
  const kbText = context.getKnowledgeBaseContext();

  const hasFocusedVideo = earlyFocused.some((fid) => {
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

  if (signal.aborted) return;
  state.setChatStatusText("");
  state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "" } : m)));

  const st = canvas.getCanvasState();
  const hasFocusedBricks = (st.focusedBrickIds || []).length > 0;
  const focusedIds: string[] = Array.isArray(st.focusedBrickIds) ? st.focusedBrickIds : [];

  let editImageUrl = "";
  const isImgBlock = (blk: any) => blk?.type === "image" || (blk?.type === "create" && (blk.mode === "image" || blk.mode === "generated"));
  const getImgSrc = (blk: any) => {
    const src = String(blk?.src || blk?.data?.src || "").trim();
    return (src && (src.startsWith("http") || src.startsWith("data:image/"))) ? src : "";
  };

  const visionImageUrls: string[] = [];
  for (const fid of focusedIds) {
    const blk = st.blocks?.[fid];
    if (!isImgBlock(blk)) continue;
    const src = getImgSrc(blk);
    if (src) {
      if (!editImageUrl) editImageUrl = src;
      if (!visionImageUrls.includes(src)) visionImageUrls.push(src);
    }
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

  const hasVideoTranscript = Boolean(
    (youtubeGrounding && youtubeGrounding.includes("Full transcript:")) || uploadedVideoTranscript
  );
  const textForServer = hasVideoTranscript ? prompt.slice(0, 16000) : cappedText;
  const recentConvo = conversationArray.slice(-8).map((m) => ({
    ...m,
    content: m.content.length > 1500 ? m.content.slice(0, 1500) + "…" : m.content,
  }));
  const truncatedConversation = p.conversationSummary
    ? [{ role: "system", content: `[CONVERSATION_SUMMARY]\n${p.conversationSummary}` }, ...recentConvo]
    : recentConvo;

  const wsContext = context.getCachedWorkspaceSummary();
  const wantsMediaPull = /\b(pull|pull\s*in|bring|bring\s*in|fetch|grab|get|show\s*me|add|put|drop|insert|place)\b.*\b(from\s*(my\s*|the\s*)?(media|saved|library|files|vault)|that\s*(image|photo|video|pdf|file|doc|link|note)\s*(i|I)\s*saved|saved\s*(content|files|media|stuff)|from\s*media|vault\s*(item|items|content|file|files|note|notes)?)\b/i.test(text)
    || /\b(my\s*saved|my\s*media|my\s*vault|the\s*vault|from\s*(my\s*|the\s*)?vault|from\s*media\s*page|media\s*page)\b/i.test(text);
  let mediaContext = "";
  if (wantsMediaPull) {
    mediaContext = wsContext?.media || "";
  }

  const [memoryText, vaultNotesForAi] = await Promise.all([
    identity.userId ? getMemoryForPrompt(identity.userId, identity.routeBoardId || identity.boardId || null) : Promise.resolve(""),
    identity.userId ? fetchNotesForVaultAi(identity.userId) : Promise.resolve([] as VaultAiNoteRow[]),
  ]);
  let workspaceContextStr = (wsContext?.full || "").slice(0, CONTEXT_BUDGETS.workspaceContext);
  try {
    if (vaultNotesForAi.length > 0) {
      const { block: vaultBlock } = buildVaultDetailForGridAi(vaultNotesForAi);
      const boardsOnly = wsContext?.boards || "";
      if (vaultBlock) {
        workspaceContextStr = [vaultBlock, boardsOnly].filter(Boolean).join("\n\n").slice(0, CONTEXT_BUDGETS.workspaceContext);
      }
    }
  } catch {
    // vault detail failed; using compact workspace summary only
  }

  const requestBody = {
    model: identity.selectedModel,
    prompt: prompt.slice(0, 16000),
    text: textForServer,
    intent: "ask",
    context: (canvasContext || "").slice(0, 14000),
    knowledgeBase: (kbText || "").slice(0, identity.projectId ? 4000 : 2000),
    conversation: truncatedConversation,
    conversationMemory: memoryText || undefined,
    workspaceContext: workspaceContextStr,
    projectId: identity.projectId,
    boardId: identity.routeBoardId || identity.boardId || undefined,
    hasFocusedBricks,
    skipWebSearch: hasVideoTranscript,
    ...(mediaContext ? { mediaContext: mediaContext.slice(0, 8000) } : {}),
    ...(editImageUrl ? { editImageUrl } : {}),
    ...(attachedImageUrls.length ? { imageUrls: attachedImageUrls } : {}),
    ...getAiPrefs(),
  };

  /* Phase 4: action path check */
  const hasFocusedTextBricks = focusedIds.some((fid) => {
    const blk = st.blocks?.[fid];
    return blk?.type === "text" && !isImgBlock(blk);
  });
  const hasBlocks = Object.keys(st.blocks || {}).length > 0;
  const wantsBlockManipulation = /\b(move|rearrange|reposition|reorganize|arrange|align|swap|shift|place|put|drag|relocate|organize|spread|stack|line up|layout|lay out|center|scatter|space out|group together|side by side|resize|make.*(bigger|smaller|wider|taller|narrower|shorter)|delete|remove|trash|clear|get rid of|clean up|connect|wire|link|disconnect|unwire|unlink)\b/i.test(cappedText) && hasBlocks;
  const wantsBlockEdit = /\b(edit|update|change|modify|rewrite|rename|set|fill in|populate|write in|add.*(to|into|in)|append|replace|fix|correct|colou?r|paint|highlight|style|theme)\b/i.test(cappedText) && hasBlocks;
  const wantsBlockCreate = /\b(create|make|build|add|start|new|insert|place|put|drop|generate|set\s*up|spin\s*up)\b/i.test(cappedText) && /\b(sheet|paper|doc|document|spreadsheet|table|budget|tracker|list|todo|checklist|task\s*board|kanban|design\s*board|code\s*block|heading|h[1-3]|quote|callout|brick|text\s*(?:block|brick)?|card|sticky|note\s*(?:block|brick)|toggle|media|image|video|embed|voice|dictat(?:e|ion))\b/i.test(cappedText);
  const wantsGridCreate = /\b(create|make|build|add|place|put|drop|generate|lay\s*out|set\s*up|write|draft|design|map\s*out|outline|sketch|plan|structure|diagram|flowchart|wireframe)\b/i.test(cappedText)
    && /\b(on\s*(?:the|my|this)?\s*(?:grid|board|canvas)|(?:grid|board|canvas)\b)/i.test(cappedText);
  const wantsOrganize = /\b(organize|sort|tidy|clean\s*up|auto[- ]?(?:layout|arrange|organize)|layout|lay\s*out|arrange|grid\s*(?:layout|organize)|group\s*(?:by|together|all)|categorize|cluster|rearrange\s*(?:everything|all|the\s*grid|my\s*(?:bricks|blocks|board)))\b/i.test(cappedText);
  const wantsNotesAction = /\b(notes?\s*(page|panel|section|pad|area)?)\b/i.test(cappedText) && /\b(edit|update|change|modify|write|rewrite|add|append|clear|set|fill|put|type|draft|compose|replace|delete|remove)\b/i.test(cappedText);
  const wantsActionPath = wantsBlockManipulation || wantsBlockEdit || wantsBlockCreate || wantsGridCreate || wantsOrganize || wantsNotesAction;
  const wantsDelete = /\b(delete|remove|trash|clear|get rid of)\b/i.test(cappedText);
  const focusedBrickActionIntent = hasFocusedTextBricks && /\b(edit|update|change|modify|rewrite|rename|set|fix|correct|colou?r|paint|highlight|style|theme|delete|remove|move|resize|make\s+(this|it)\s+\w|write|fill|replace|append|add\s+(to|into)|clear|format)\b/i.test(cappedText);

  let responseBlockId: string | null = null;

  if ((focusedBrickActionIntent || wantsActionPath) && !editImageUrl) {
    const statusMsg = wantsNotesAction ? "Writing notes..."
      : wantsDelete ? "Removing blocks..."
      : wantsOrganize ? "Organizing grid..."
      : wantsBlockEdit ? "Editing blocks..."
      : (wantsBlockCreate || wantsGridCreate) ? "Creating blocks..."
      : wantsBlockManipulation && !focusedBrickActionIntent ? "Arranging blocks..."
      : "Editing bricks...";
    const handled = await handleActionPath(p, apiBase, requestBody, cappedText, conversationArray, promptId, responseBlockId, statusMsg);
    if (handled) return;
  }

  /* Phase 5: streaming or invoke */
  let streamResponse: Response | null = null;
  let useStreaming = false;
  try {
    const timeout = setTimeout(() => abortController.abort(), 120000);
    streamResponse = await fetch(`${apiBase}/api/ai/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal,
    });
    clearTimeout(timeout);
    if (streamResponse.ok && streamResponse.headers.get("content-type")?.includes("text/event-stream")) {
      useStreaming = true;
    }
    // The server swaps to a cheaper model for out-of-tier requests; tell the
    // user so they know why they got a different answer than expected.
    maybeNotifyModelDowngrade(streamResponse);
  } catch {
    streamResponse = null;
  }

  if (useStreaming && streamResponse) {
    const streamResult = await handleStreamingResponse(p, streamResponse, promptId, responseBlockId, text);
    let accumulated = streamResult.accumulated;
    responseBlockId = streamResult.responseBlockId;

    if (streamRefs.streamTypingRafRef.current) { clearTimeout(streamRefs.streamTypingRafRef.current); streamRefs.streamTypingRafRef.current = null; }
    if (streamRefs.streamPromptIdRef.current && streamRefs.streamDisplayedLenRef.current < streamRefs.streamTargetTextRef.current.length) {
      state.setChatMessages((prev) => prev.map((m) => (m.id === streamRefs.streamPromptIdRef.current ? { ...m, aiResponse: streamRefs.streamTargetTextRef.current } : m)));
    }
    streamRefs.streamTargetTextRef.current = "";
    streamRefs.streamDisplayedLenRef.current = 0;
    streamRefs.streamPromptIdRef.current = null;

    await postProcessResponse(p, accumulated, promptId, responseBlockId, youtubeGrounding, youtubeTranscriptSource, asksAboutVideo, cappedText);
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
      const finalText = "This model isn\u2019t working properly right now \u2014 try another model.";
      state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: finalText } : m)));
      p.aiThread.push({ role: "assistant", content: finalText });
      if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
      if (responseBlockId) await typing.typeIntoAiResponseBlock(responseBlockId, finalText);
      state.setChatStatusText("Answered");
      return;
    }
    if ((data as any)?.type === "image" && (data as any)?.url) {
      const imageUrl = String((data as any).url);
      state.setChatMessages((prev) => prev.map((m) => (m.id === promptId ? { ...m, aiResponse: "[Generated Image]", aiImageUrl: imageUrl } : m)));
      p.aiThread.push({ role: "assistant", content: `[Generated Image](${imageUrl})` });
      if (p.aiThread.length > 40) p.aiThread.splice(0, p.aiThread.length - 40);
      const stImg = canvas.getCanvasState();
      const gImg = Math.max(1, Math.floor(stImg.gridSize || 24));
      let imgX: number, imgY: number;
      if (responseBlockId && stImg.blocks?.[responseBlockId]) {
        imgX = stImg.blocks[responseBlockId].x ?? 100;
        imgY = stImg.blocks[responseBlockId].y ?? 100;
        try { canvas.deleteBlock(responseBlockId); } catch {}
      } else {
        const imgPos = findSmartPlacementForImage(stImg, gImg);
        imgX = imgPos.x;
        imgY = imgPos.y;
      }
      stImg.addBlock({
        id: `create-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        type: "create", mode: "image",
        x: imgX, y: imgY, width: gImg * 12, height: gImg * 12,
        data: { src: imageUrl },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      uploadAiImageToStorage(p, promptId, imageUrl);
      state.setChatStatusText("Image generated");
      return;
    }

    let invokeAiText = String(data?.response || data?.answer || data?.text || "").trim();
    await typing.typeResponseIntoChat(promptId, analysis.sanitizeAssistantResponse(invokeAiText) || "I'm not sure how to answer that. Could you rephrase?");
    await postProcessResponse(p, invokeAiText, promptId, responseBlockId, youtubeGrounding, youtubeTranscriptSource, asksAboutVideo, cappedText);
  }
}
