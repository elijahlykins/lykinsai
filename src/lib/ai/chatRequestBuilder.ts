// Request-assembly stage of the chat send pipeline: fold the prepared turn
// (history, attachment context, YouTube grounding) plus device-side context
// (Local Mode, installed apps, Mac apps, AI Drive, conversation memory) into
// the JSON body /api/ai/stream and /api/ai/invoke consume. Extracted
// VERBATIM from chatSendOrchestrator.ts (C3B decomposition, see
// docs/REFACTOR_LOG.md) minus the dead canvas context / focused-bricks /
// vision-image-scan branches. Field budgets and truncation points are
// server-visible contracts — keep them exactly as-is.
import { getAiPrefs } from "@/lib/ai-prefs";
import { isLocalModeAvailable, refreshLocalMode } from "@/lib/localMode";
import { getDesktopMcpAppsSummary, isDesktopMcpAvailable } from "@/lib/mcp/desktopMcpBridge";
import { getMemoryForPrompt } from "@/lib/conversationMemory";
import { loadActiveCustomModelId } from "@/lib/modelBuilder/activeCustomModelStorage";
import { CUSTOM_MODELS_ENABLED } from "@/lib/customModelsEnabled";
import { listAiDrive, type AiDriveListing } from "@/lib/vault/aiDriveContents";
import { messageWantsDeviceInventory } from "@/lib/ai/deviceInventoryIntent";
import { listInstalledApps } from "@/lib/apps/installApp";
import { macAppNames } from "@/lib/macApps";
import type { ChatSendParams } from "@/lib/ai/chatSendOrchestrator";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";
import { collectThreadFolderAttachments, folderPathFromAttachment } from "@/lib/ai/chatTurnPreparation";
import { attachedAppsFromComposer } from "@/lib/chat/slashAppQuery";
import { browserPageContextForRequest } from "@/lib/lyknChat/browserSurfaceContext";
import { readLocalModelSetup } from "@/lib/models/modelSetupStore";

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

const EMPTY_DRIVE: AiDriveListing = {
  items: [],
  artifacts: 0,
  docs: 0,
  images: 0,
  complete: true,
};

export async function buildChatRequestBody(args: {
  p: ChatSendParams;
  cappedText: string;
  history: string;
  conversationArray: Array<{ role: string; content: string; model?: string; at?: string }>;
  attachmentContext: string;
  youtubeGrounding: string;
  youtubeTranscriptSource: string;
  promptAttachments?: FocusedChatAttachment[];
}): Promise<{ requestBody: Record<string, unknown>; hasVideoTranscript: boolean }> {
  const { p, cappedText, history, conversationArray, attachmentContext, youtubeGrounding, youtubeTranscriptSource } = args;
  const promptAttachments = args.promptAttachments || p.sentAttachments;
  const { text, sentAttachments, brickActionData, identity, context } = p;

  const videoTranscriptBlock = youtubeGrounding
    ? (youtubeTranscriptSource === "description_fallback"
        ? `[VIDEO DESCRIPTION ONLY — The text below is the video's description metadata, NOT a transcript of its spoken audio. We attempted to transcribe the audio (captions + Whisper speech-to-text) but could not obtain a transcript — likely because the audio could not be downloaded from YouTube for this video. Do NOT treat this as what was said in the video. If the user asks to transcribe or asks what was said, explain that you attempted automatic transcription but it failed for this video, and you only have the description.]\n${youtubeGrounding}`
        : youtubeGrounding.includes("Full transcript:")
          ? `[VIDEO TRANSCRIPT — Use this to answer the user's question about the video. Do NOT say you cannot access the video. The transcript below IS the video's content.]\n${youtubeGrounding}`
          : `YouTube transcript context:\n${youtubeGrounding}`)
    : "";
  const prompt = [
    history ? `Conversation so far:\n${history}` : "",
    videoTranscriptBlock,
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

  const kbText = context.getKnowledgeBaseContext();

  const hasVideoTranscript = Boolean(youtubeGrounding && youtubeGrounding.includes("Full transcript:"));
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
  const browserAsk = p.surfaceContext?.surface === "browser";
  const inventoryHaystack = [
    cappedText,
    ...conversationArray.slice(-4).map((m) => m.content),
  ].join("\n");
  const wantsInventory = !browserAsk && messageWantsDeviceInventory(inventoryHaystack);

  const customModelId = CUSTOM_MODELS_ENABLED
    ? identity.customModelId ?? (identity.userId ? loadActiveCustomModelId() : null)
    : null;
  // Memory, Local Mode, and device inventory used to await in series. Local
  // Mode still needs a live IPC read (the cache starts false). Drive / Mac
  // apps / installed apps only go out on open/launch/file-ish turns so a
  // cold Drive page does not sit in front of first token.
  const [memoryText, localModeOn, installedApps, macApps, aiDrive, desktopMcpApps] = await Promise.all([
    skipMemoryPrefetch
      ? Promise.resolve("")
      : getMemoryForPrompt(
          identity.userId,
          identity.routeChatId || identity.chatId || null,
          cappedText,
        ),
    isLocalModeAvailable() ? refreshLocalMode() : Promise.resolve(false),
    wantsInventory
      ? listInstalledApps().then((apps) =>
          apps.slice(0, 60).map((app) => ({ id: app.id, name: app.name })),
        )
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    wantsInventory ? macAppNames().then((names) => names.slice(0, 200)) : Promise.resolve([] as string[]),
    wantsInventory ? listAiDrive(identity.userId) : Promise.resolve(EMPTY_DRIVE),
    // Desktop MCP servers (Blender, Ableton, …) connected on this machine.
    // Cached bridge read — the server arms local_mcp_* tools when non-empty.
    browserAsk ? Promise.resolve([]) : getDesktopMcpAppsSummary().catch(() => []),
  ]);
  const requestBody: Record<string, unknown> = {
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
    ...(p.imageModel && p.composerMode === "image"
      ? { imageModel: String(p.imageModel).trim().slice(0, 120) }
      : {}),
    // "+" → Create submenu: build a rich artifact (deck, study guide, chart…).
    ...(typeof p.composerMode === "string" && p.composerMode.startsWith("create:")
      ? { forceArtifact: true, artifactType: p.composerMode.slice("create:".length) }
      : {}),
    // Artifact open in the preview popup — let the server refine it in place.
    ...(p.activeArtifact ? { activeArtifact: p.activeArtifact } : {}),
    // Opt this turn into the agent loop (chat-agent-loop.js). Authenticated
    // chat path only — the model can call the in-app tool whitelist
    // (mcp-tools/chatTools.js) to use Markdown Memory and product tools via
    // OpenAI function-calling, and the SSE stream interleaves tool_call
    // events with text deltas. Server forces an OpenAI tool-capable model
    // when this is on; X-Tool-Route header announces the swap.
    useTools: true,
    // Local Mode — when the user flipped the Vault switch AND we're in the
    // desktop shell, offer file/terminal tools that execute on their machine.
    ...(localModeOn && !browserAsk ? { localMode: true } : {}),
    // Desktop MCP — servers running on this machine (Blender, Ableton, …).
    // Independent of Local Mode: connecting the server was its own consent.
    ...(desktopMcpApps.length ? { desktopMcpApps } : {}),
    // Bridge presence, separate from connections: lets the server arm the
    // catalog/connect tools at ZERO connections ("connect to blender" on a
    // fresh install). Each connect still gets its own approval card.
    ...(isDesktopMcpAvailable() && !browserAsk ? { desktopMcpAvailable: true } : {}),
    // Build workspace — Studio Build in the desktop shell arms the on-disk
    // build tools (~/LYKN/Builds). Independent of the Local Mode switch: with
    // Local Mode off, Electron confines every call to the workspace root.
    ...(p.buildWorkspace === true && isLocalModeAvailable() && !browserAsk
      ? { buildWorkspace: true }
      : {}),
    // The user's IANA timezone (browser-resolved) so the server can give the
    // model the user's LOCAL "now" + offset. Without this, scheduling tools
    // (createEvent/createReminder) land events at the wrong time because the
    // model has no idea what timezone the user means by "3pm".
    timezone: resolveLocalTimezone(),
    ...(attachedImageUrls.length ? { imageUrls: attachedImageUrls } : {}),
    ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
    ...(() => {
      const attachedApps = attachedAppsFromComposer(promptAttachments);
      return attachedApps.length ? { attachedApps } : {};
    })(),
    ...(() => {
      // Only folders on THIS send (or a related follow-up the client already
      // gated into promptAttachments). Do not re-arm every later turn from
      // the whole thread.
      const folders = collectThreadFolderAttachments([], promptAttachments)
        .map((f) => ({
          name: f.name || f.vaultTitle || "folder",
          path: folderPathFromAttachment(f),
        }))
        .filter((f) => f.path)
        .slice(0, 8);
      return folders.length ? { attachedFolders: folders } : {};
    })(),
    ...(!browserAsk && installedApps.length ? { installedApps } : {}),
    ...(!browserAsk && macApps.length ? { macApps } : {}),
    ...(!browserAsk && aiDrive.items.length
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
    userSettings: readLocalModelSetup(),
  };

  if (browserAsk) requestBody.browserAsk = true;
  const browserPageContext = browserPageContextForRequest(p.surfaceContext);
  if (browserPageContext) requestBody.browserPageContext = browserPageContext;

  return { requestBody, hasVideoTranscript };
}
