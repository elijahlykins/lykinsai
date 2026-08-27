// POST /api/ai/local-tool-result + POST /api/ai/stream.
// Stream is load-bearing SSE. Local-tool-result writes the same process
// singleton as the stream handler (`localToolBridge`).
import { createRequire } from 'module';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { searchWeb, formatSearchResultsForPrompt, extractSourcesFromSearchPrompt } from '../../lib/exterior/webSearch.js';
import { runDeepResearchForPrompt } from '../../lib/exterior/deepResearch.js';
import { fetchWebPage } from '../../lib/exterior/webFetch.js';
import { persistCapabilityArtifact } from '../../lib/exterior/capabilityStorage.js';
import { safeFetch } from '../../lib/exterior/ssrfGuard.js';
import {
  getOrCreateSession,
  logAiUsage,
  classifyActionType,
  estimateTokens,
  detectProvider,
  extractOpenAIUsage,
  extractAnthropicUsage,
  extractGeminiUsage,
  extractGrokUsage,
} from '../../usageTracking.js';
import {
  isModelAllowedForPlan,
  defaultModelForTier,
  classifyModel,
} from '../../src/lib/modelTiers.js';
import {
  isTogetherDedicatedEndpointError,
  isTogetherInferenceModel,
  isTogetherLoraInferenceRetryableError,
} from '../../lib/lora/togetherLora.js';
import { buildTogetherChatBody } from '../../lib/lora/togetherServerlessLora.js';
import {
  buildTogetherLoraMessages,
  extractSupplementalUserContext,
} from '../../lib/lora/togetherLoraChat.js';
import {
  applyCustomModelOverlayToPrompt,
  buildProviderModelChain,
} from '../../lib/modelBuilder/customModelChat.js';
import { resolveCustomModelChatTools } from '../../lib/modelBuilder/customModelChatTools.js';
import {
  readIsMainAgent,
  readSubModelIds,
  loadSubModelRoster,
  formatMainAgentOrchestrationBlock,
  loadPublishedRoster,
  formatDefaultMainAgentBlock,
} from '../../lib/modelBuilder/mainAgentOrchestration.js';
import { CUSTOM_MODELS_ENABLED } from '../../lib/customModelsEnabled.js';
import { runSubModelDelegate } from '../../lib/modelBuilder/runSubModelDelegate.js';
import {
  createSubModelTask,
  listSubModelTasks,
  getSubModelTask,
  listUndeliveredCompletedTasks,
  markSubModelTasksNotified,
} from '../../lib/modelBuilder/subModelTasksService.js';
import { enqueueSubModelTask } from '../../lib/modelBuilder/subModelTaskRunner.js';
import {
  getCustomModelChatPersonaStatic,
  getCustomModelStreamPersonaFull,
} from '../../lib/modelBuilder/lyknCustomModelRuntimePersona.js';
import { CHAT_TOOLS, buildChatToolCtx, providerForModel, resolveChatModelLabel, supportsTools } from '../../mcp-tools/chatTools.js';
import { LOCAL_TOOL_NAMES, looksLikeLocalSystemAsk, mightBeBrowserTaskAsk } from '../../mcp-tools/localTools.js';
import {
  AGENTS_APPS_CODE_INTENT_RE,
  messageWantsAgentTools,
  messageWantsPageFetch,
  messageWantsProjectContext,
  messageWantsSavedRecall,
  messageWantsWebTools,
} from '../../mcp-tools/chatIntentSignals.js';
import { resolveChatTurnDisclosure, composeWithExternalTools } from '../../mcp-tools/firstPartyCapabilities.js';
import { buildSlimChatToolGuidance } from '../../mcp-tools/chatToolGuidance.js';
import { getMcpManager } from '../routes/mcp.routes.js';
import { resolveMcpToolsForTurn, bindMcpChatHandlers } from '../../lib/mcp/chatTurn.js';
import {
  formatBoundProjectGuidance,
  loadWritableProject,
  stampActiveProject,
} from '../../lib/projectWriteTarget.js';
import { runAgentLoop, makeToolSyntaxStripper, stripToolSyntaxFromText } from '../../chat-agent-loop.js';
import {
  sanitizeUserContent,
  sanitizeTurnArray,
  sanitizeUserContentWithCount,
  sanitizeTurnArrayWithCount,
} from '../../prompt-sanitizer.js';
import { SecurityEvent, logSecurityEvent } from '../../security-logger.js';
import {
  sha256,
  sanitizeStaleSurfaceLanguage,
  splitPromptForProvider,
  getOrCreateGeminiCache,
  OUTPUT_CAPS,
  clampForProvider,
  pickOutputCap,
} from './promptUtils.js';
import {
  resolveUserRecallMode,
  USER_RECALL_TURN_PROMPT,
  USER_RECALL_DEEPEN_PROMPT,
  GREETING_TURN_PROMPT,
  messageIsPureGreeting,
  isCasualOverlayAck,
  LYKN_CHAT_PERSONA_STATIC,
  GUEST_SYSTEM_PROMPT,
  GLASS_DEMO_ADDENDUM,
  LYKN_MEMORY_WRITE_INSTRUCTIONS,
  LYKN_STREAM_PERSONA_FULL,
  LYKN_GLASS_STREAM_PERSONA_SLIM,
  LYKN_CHAT_STREAM_PERSONA_SLIM,
  buildResponseLengthNote,
  ARTIFACT_BUILD_SPEC,
  detectArtifactIntent,
  detectImageFollowUpIntent,
  isFreshWebappBuildAsk,
  buildChatToolGuidance,
  buildLandingOnboardingSystemPrompt,
  AI_BUDGETS,
  MAX_USER_INPUT_CHARS,
  compressConversation,
  buildAssistantIdentitySection,
  buildInstalledAppsSection,
  buildMacAppsSection,
  buildAiDriveSection,
} from './chatGuidance.js';
import {
  hasExplicitUrlScrapeIntent,
  scrapeUrlsFromText,
  formatUntrustedWebObservation,
  attachUntrustedWebObservation,
  classifyEnrichment,
  shouldEmbedWorkspaceContext,
  isTrivialTurn,
  runWebSearchIfNeeded,
  runYouTubeSearchIfNeeded,
  URL_DETECT_RE,
  needsYouTubeSearch,
  BOARD_CONTEXT_FOCUSED_CHARS,
} from './webEnrichment.js';
import {
  LOCAL_TOOL_WAIT_MS,
  registerLocalToolStream,
  releaseLocalToolStream,
  resolveLocalToolResult,
} from './localToolBridge.js';
import { localTimeContextLine } from './timeContext.js';
import {
  MODEL_CATALOG,
  LYKN_ROUTED_MODELS,
  resolveLyknAlias,
  normalizeRequestedModel,
  upgradeModelForVision,
  codedArtifactModelAvailable,
  upgradeModelForCodedArtifact,
  isOpenAIModel,
  isTogetherModel,
  isRetryableProviderError,
  getFallbackModels,
  AI_TEMPORARY_FAILURE_TEXT,
  IMAGE_GEN_FAILURE_TEXT,
  VIDEO_RENDER_INTENT_RE,
  BUILD_SCREEN_REF_RE,
  extractPureUserMessage,
  resolveAnthropicModel,
  parseOpenAIResponsesText,
  invokeOpenAIModel,
  getDynamicOpenAIGptModels,
} from './modelInvoke.js';
import {
  invalidateProjectSectionCache,
  loadCustomModelForChat,
  fetchCustomModelKnowledgeSection,
  readCustomModelLinkedProjectId,
  fetchProjectSection,
} from './chatContext.js';
import { PROJECT_WRITE_TOOLS } from './chatToolCtx.js';

const require = createRequire(import.meta.url);
const webSearchIntent = require('../../lib/webSearchIntent.cjs');
const artifactBuildIntent = require('../../lib/artifactBuildIntent.cjs');
const {
  detectImageIntent,
  detectReferenceImageAsk,
  IMAGE_INTENT_NOUN_RE,
} = require('../../lib/imageGenIntent.cjs');

export function registerAiStreamRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  checkAiUsageLimit,
  supabaseAdmin,
  sanitizePromptBundle,
  resolveProductionChatMemory,
}) {
  // Local Mode result relay — the desktop app posts the outcome of a local
  // tool (file / terminal) it ran here so the in-flight /api/ai/stream turn can
  // resume. Matched to the awaiting call by (streamId, toolCallId); scoped to
  // the authenticated user. The server never runs the tool itself.
  app.post('/api/ai/local-tool-result', requireAuth, async (req, res) => {
    const streamId = String(req.body?.streamId || '');
    const toolCallId = String(req.body?.toolCallId || '');
    const result = req.body?.result;
    if (!streamId || !toolCallId) {
      return res.status(400).json({ ok: false, error: 'streamId and toolCallId are required' });
    }
    const delivered = resolveLocalToolResult(streamId, req.user?.id, toolCallId, result);
    if (!delivered) {
      return res.status(404).json({ ok: false, error: 'No local tool call is waiting for this result.' });
    }
    return res.json({ ok: true });
  });

  app.post('/api/ai/stream', requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit, async (req, res) => {
    // ─── Latency diagnostics ─────────────────────────────────────────
    // We are chasing a "first message takes 20-30s" report and the
    // existing logs don't have timestamps so we can't see which phase
    // costs what. These checkpoints log ms-since-request-start every
    // stage. Remove once perf is verified stable.
    const _t0 = Date.now();
    const _ck = (label) => console.log(`⏱  [+${Date.now() - _t0}ms] ${label}`);
    try {
      _ck('entered /api/ai/stream');
      const normalizedModel = normalizeRequestedModel(req.body?.model);
      const rawIncomingImageUrls = Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : [];
      // Providers fetch anything that isn't inline base64, and one they can't
      // reach fails the whole turn instead of the one image — a desktop-only
      // scheme (lykn-blob:// / lykn-mac://) used to cost the user their reply.
      // The client inlines those bytes before sending; anything that slips
      // through is dropped so the turn still answers. Mirrors /api/ai/invoke.
      const incomingImageUrls = rawIncomingImageUrls
        .map((u) => String(u || '').trim())
        .filter((u) => u.startsWith('http') || u.startsWith('data:image/'));
      const droppedImageUrls = rawIncomingImageUrls.length - incomingImageUrls.length;
      if (droppedImageUrls > 0) {
        console.warn(
          `🖼 Stream: dropped ${droppedImageUrls} unfetchable image url(s): ` +
            rawIncomingImageUrls
              .filter((u) => !incomingImageUrls.includes(String(u || '').trim()))
              .map((u) => String(u || '').slice(0, 60))
              .join(', '),
        );
      }
      // `let`: coded-artifact turns may drop the overlay's auto-screenshot so
      // the build can stay on grok (which can't take images on forced tools).
      let imageUrls = incomingImageUrls.slice(0, 8);
      let { prompt, text, intent, context, knowledgeBase, projectId, conversation, conversationMemory, userPrompt, responseLength, hasFocusedBricks, skipWebSearch, workspaceContext, overlayAsk, liveWatch } = req.body;
      // Electron Agent Mode / owned-browser tool drafts — never redirect to Glass Build/Create.
      const agentMode = req.body?.agentMode === true;
      const toolDraft = req.body?.toolDraft === true;
      const aiName = req.body?.aiName;
      // Chat-bar "+" capability modes. The client sets one of these when the
      // user explicitly armed a mode for this turn, so we force the matching
      // behavior deterministically instead of relying on the model's choice.
      // Regular chat also auto-arms forceWebSearch after sanitize when the
      // message needs live/post-cutoff facts (same detector Glass uses).
      let forceWebSearch = req.body?.forceWebSearch === true;
      const deepResearch = req.body?.deepResearch === true;
      const researchSourcePref = String(req.body?.researchSourcePref || 'all')
        .trim()
        .toLowerCase()
        .slice(0, 32);
      // Glass open-tab URL + site-wide ask → keep web_fetch / pre-fetch armed.
      const overlayPageUrl = String(req.body?.pageUrl || '').trim().slice(0, 500);
      const forcePageFetch =
        req.body?.forcePageFetch === true || messageWantsPageFetch(String(text || ''));
      const translateMode = req.body?.translateMode === true;
      let forceImage = req.body?.forceImage === true;
      // Chat-bar "+" → Create: the user asked to BUILD a rich artifact (deck,
      // study guide, chart, diagram, document, mini-app) — claude.ai-style
      // Artifacts. We map the chosen type to the exact builder tool and force
      // that tool on this turn (see ARTIFACT_BUILD_SPEC).
      const forceArtifact = req.body?.forceArtifact === true;
      let artifactType = (String(req.body?.artifactType || '').trim() || null);
      // Exclusive composer modes are mutually exclusive with Create inference.
      // Deep research + "create a report we will use for an investor pitch" must
      // stay a written research report — not lykn_build_react_artifact.
      // NOTE: do NOT key off bare forceWebSearch — Glass also auto-arms that for
      // live-freshness asks without the user opening Web mode.
      const composerModeRaw = String(req.body?.composerMode || '').trim();
      const exclusiveComposerMode = deepResearch
        ? 'research'
        : forceImage && !forceArtifact
          ? 'image'
          : translateMode
            ? 'translate'
            : composerModeRaw === 'web'
              ? 'web'
              : null;
      // Research/web/image/translate: no Create at all.
      const lockOutArtifactBuilds = !!exclusiveComposerMode;
      // Regular chat (Create/Build NOT armed): never auto-start a new artifact.
      // Open-panel refine only runs while Create/Build is armed; Chat mode may
      // send a discussOnly stub so the model can talk about the open panel.
      const allowNewArtifactBuild = forceArtifact === true;
      // "+" → Create / Glass Build is the ONLY way to force a new artifact build.
      // Typed "build me a deck" in regular chat used to auto-infer Create and
      // hijack brainstorms — that path is retired.
      let artifactAutoInferred = false;

      // Resolve / sanitize activeArtifact BEFORE any inference gates. Untagged
      // or wrong-chat panel payloads used to short-circuit "build me a game"
      // into surgical-edit mode and then hang on rejected full_rewrite calls.
      let activeArtifact =
        req.body?.activeArtifact && typeof req.body.activeArtifact === 'object' && !Array.isArray(req.body.activeArtifact)
          ? req.body.activeArtifact
          : null;
      const requestChatId = String(req.body?.chatId || '').trim();
      const artifactSourceChatId = String(activeArtifact?.sourceChatId || '').trim();
      if (activeArtifact && requestChatId) {
        if (!artifactSourceChatId) {
          console.log(
            `🎨 Stream: ignoring untagged activeArtifact "${String(activeArtifact.title || '').slice(0, 60)}" — no sourceChatId (refuse cross-chat leak)`,
          );
          activeArtifact = null;
        } else if (artifactSourceChatId !== requestChatId) {
          console.log(
            `🎨 Stream: ignoring activeArtifact "${String(activeArtifact.title || '').slice(0, 60)}" — sourceChatId ${artifactSourceChatId.slice(0, 8)}… ≠ chat ${requestChatId.slice(0, 8)}…`,
          );
          activeArtifact = null;
        }
      }
      // Chat mode discuss stub: title-only context, never an edit session.
      const activeArtifactDiscussOnly =
        !!activeArtifact && activeArtifact.discussOnly === true;
      if (activeArtifactDiscussOnly && activeArtifact) {
        // Drop any accidental source payloads so editable gates stay false.
        activeArtifact = {
          toolName: String(activeArtifact.toolName || ''),
          title: String(activeArtifact.title || 'Untitled').slice(0, 200),
          sourceChatId: artifactSourceChatId || undefined,
          discussOnly: true,
          templateType:
            typeof activeArtifact.templateType === 'string'
              ? activeArtifact.templateType
              : undefined,
        };
        console.log(
          `💬 Stream: open artifact "${String(activeArtifact.title || '').slice(0, 60)}" is discuss-only (Chat mode — no edits)`,
        );
      }
      // Exclusive non-Create modes: ignore open-panel refine so research/web/
      // translate/image turns cannot get trapped into builder edits.
      // discussOnly stubs are fine to keep (read-only context).
      if (lockOutArtifactBuilds && activeArtifact && !activeArtifactDiscussOnly) {
        console.log(
          `🔒 Stream: exclusive mode (research=${deepResearch}, web=${forceWebSearch && !deepResearch}, image=${forceImage}, translate=${translateMode}) — ignoring open artifact "${String(activeArtifact.title || '').slice(0, 60)}"`,
        );
        activeArtifact = null;
      }
      const hasActiveArtifactBody = !!activeArtifact && !activeArtifactDiscussOnly;

      // Images are Imagine-only (or an explicit "+" / overlay "Create an image"
      // arm). Regular chat used to auto-force lykn_generate_image from wording
      // ("generate an image of a dog") and from follow-up tweaks — that raced
      // the mode pills and skipped the "switch to Imagine" redirect. Mirror
      // Create: never infer. Client-armed forceImage still generates.
      const hasAttachedImage = Array.isArray(imageUrls) && imageUrls.length > 0;
      if (!forceImage) {
        const wouldHaveInferred =
          !forceArtifact &&
          !hasActiveArtifactBody &&
          !lockOutArtifactBuilds &&
          (detectImageIntent(text || '', { hasAttachedImage }) ||
            detectReferenceImageAsk(text || '', hasAttachedImage) ||
            detectImageFollowUpIntent(text || '', conversation));
        if (wouldHaveInferred) {
          console.log(
            '🔒 Stream: regular chat — refusing image auto-infer; user must switch to Imagine',
          );
        } else if (IMAGE_INTENT_NOUN_RE.test(String(text || ''))) {
          // Diagnostic: the message mentions an image noun but the intent detector
          // said no — log what we actually saw so misses are debuggable from the
          // server log instead of guessing at the client's phrasing.
          console.log(
            `🖼 Stream: image-ish message did NOT trip inference (forceArtifact=${forceArtifact}, activeArtifact=${hasActiveArtifactBody}) — text[0..160]=${JSON.stringify(String(text || '').slice(0, 160))}`,
          );
        }
      }
      // Iterative image refinement: when this image turn follows a generated
      // image, pull that image's URL out of the last assistant reply so the
      // prompt can hand it to the model as an explicit pixel reference
      // (reference_image_urls) — refinements stay grounded in the previous
      // render instead of being regenerated from a fresh text description.
      let imageFollowUpRefUrl = null;
      if (forceImage && Array.isArray(conversation)) {
        for (let i = conversation.length - 1; i >= 0 && !imageFollowUpRefUrl; i--) {
          const m = conversation[i];
          const role = m && typeof m === 'object' ? String(m.role || '') : '';
          if (role !== 'assistant' && role !== 'model') continue;
          const matches = [...String(m.content || '').matchAll(/!\[(?!lykn[-_]artifact:)[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)];
          if (matches.length) imageFollowUpRefUrl = matches[matches.length - 1][1];
          break; // only the LAST assistant turn counts — older images are stale context
        }
      }
      // Regular chat: never auto-infer Create from wording. Only forceArtifact
      // (user armed Create/Build) starts a new build.
      if (!allowNewArtifactBuild && !forceImage) {
        const wouldHaveInferred =
          !hasActiveArtifactBody &&
          !lockOutArtifactBuilds &&
          detectArtifactIntent(text || '', { glassScreenFirst: !!overlayAsk });
        if (wouldHaveInferred || artifactBuildIntent.isTypedNewDeliverableAsk(text || '')) {
          console.log(
            `🔒 Stream: regular chat — refusing Create auto-infer (${wouldHaveInferred || 'typed deliverable'}); user must arm Build/Create`,
          );
        } else if (lockOutArtifactBuilds) {
          console.log(
            `🔒 Stream: skipping artifact auto-infer — exclusive mode locked (deepResearch=${deepResearch})`,
          );
        }
      }
      // Glass Build mode defaults to webapp; remap to chart/diagram when the
      // typed ask clearly commissions one (Build mode is the opt-in gate).
      if (overlayAsk && forceArtifact) {
        const glassBuildKind = detectArtifactIntent(text || '', { glassScreenFirst: false });
        if (glassBuildKind === 'chart' || glassBuildKind === 'diagram') {
          artifactType = glassBuildKind;
          console.log(`🪟 Stream: Glass Build mode + ${glassBuildKind} ask — forcing ${glassBuildKind} builder`);
        }
      }
      let artifactBuildSpec = (forceArtifact || artifactAutoInferred)
        ? (ARTIFACT_BUILD_SPEC[artifactType] || ARTIFACT_BUILD_SPEC.document)
        : null;
      let artifactToolName = artifactBuildSpec ? artifactBuildSpec.tool : null;
      // Build mode + an explicit VIDEO-FILE ask ("make an mp4 of my logo",
      // "turn that image into a video") should render a real .mp4 via Remotion,
      // not force an interactive React artifact. Tight match: the video noun
      // must be the requested deliverable, not incidental ("landing page with a
      // video section" stays a React build).
      if (
        artifactToolName === 'lykn_build_react_artifact' &&
        /(?:\bmp4\b|\bvideo file\b|\b(?:make|create|render|generate|turn|animate)\b[^.?!\n]{0,50}\binto (?:a |an )?(?:mp4|video)\b|\b(?:make|create|render|generate)\b(?:\s+(?:me|us))?\s+(?:a|an)\s+(?:short\s+|quick\s+|little\s+|looping\s+)*(?:video|animation)\b)/i.test(String(text || ''))
      ) {
        artifactBuildSpec = { tool: 'lykn_render_video', label: 'rendered .mp4 video', templateType: null };
        artifactToolName = 'lykn_render_video';
        console.log('🎬 Stream: build request asks for a video file — forcing lykn_render_video instead of the React artifact builder');
      }
      const activeArtifactHasSource =
        !!activeArtifact &&
        !activeArtifactDiscussOnly &&
        (
          (activeArtifact.toolName === 'lykn_build_template' &&
            (Array.isArray(activeArtifact.sections) || typeof activeArtifact.content === 'string')) ||
          (activeArtifact.toolName === 'lykn_build_react_artifact' &&
            ((typeof activeArtifact.code === 'string' && activeArtifact.code.trim()) ||
              (Array.isArray(activeArtifact.files) && activeArtifact.files.length > 0))) ||
          (activeArtifact.toolName === 'lykn_manage_file' &&
            typeof activeArtifact.fileContent === 'string' &&
            activeArtifact.fileContent.trim()) ||
          (activeArtifact.toolName === 'lykn_build_spreadsheet' &&
            (Array.isArray(activeArtifact.headers) || Array.isArray(activeArtifact.rows)))
        );
      // Edit-in-Build on an installed app: the source is attached so each turn
      // patches THAT app even though it is not an open preview. This identifies
      // the target; it does not by itself authorize a full rewrite.
      const appEditTurn =
        activeArtifactHasSource &&
        typeof activeArtifact?.installedAppId === 'string' &&
        !!String(activeArtifact.installedAppId).trim();
      // Prefer surgical refine over Create/forceArtifact whenever an editable
      // artifact is open and the user did NOT explicitly ask to redesign.
      // Leaving "+" → Create armed used to nullify the edit path, inject a
      // fresh [DESIGN_SYSTEM], and force a ground-up rebuild that looked
      // totally different from the open panel.
      //
      // Exception: Build mode (artifactType webapp) / reference-image rebuild
      // asks are fresh coded builds — keep the builder and drop the open panel
      // so "exact clone of this image" doesn't hang on edits_required.
      const askText = String(text || '');
      const redesignArtifactAsk =
        !lockOutArtifactBuilds && artifactBuildIntent.isRedesignAsk(askText);
      // New-build commissions only when Create/Build is armed.
      const insistFreshBuildAsk =
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        artifactBuildIntent.isInsistFreshBuildAsk(askText);
      const typedNewDeliverableAsk =
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        artifactBuildIntent.isTypedNewDeliverableAsk(askText);
      // In regular chat, still detect "build me a …" so we can ask the user to
      // switch into Create/Build — without arming a builder.
      // Agent Mode already opens real tools (Docs/Sheets/…) and drafts plain text
      // to paste — never tell them to arm Glass Build/Create for that.
      const regularChatBuildAsk =
        !agentMode &&
        !toolDraft &&
        !allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        (artifactBuildIntent.isTypedNewDeliverableAsk(askText) ||
          !!detectArtifactIntent(askText, { glassScreenFirst: !!overlayAsk }) ||
          artifactBuildIntent.isInsistFreshBuildAsk(askText));
      // Narrow style asks ("make it blue", "change the font") may touch colors/
      // fonts without being a full redesign — builders allow that signature
      // churn only when this is set.
      const styleChangeArtifactAsk =
        /\b(?:font|typeface|typography|colou?r|theme|accent|palette|recolou?r|background|neutral|gr[ae]yscale|monochrome|dark\s*mode|light\s*mode|darken|brighten|dim(?:mer)?|muted?|opacity|red|orange|yellow|green|blue|purple|pink|black|white|gray|grey|amber|mustard)\b/i.test(
          askText,
        ) || redesignArtifactAsk;
      // Edit/add asks against an open artifact — keep in sync with useChatEngine.
      const looksLikeSurgicalTweak =
        askText.trim().length < 400 &&
        /\b(?:fix|change|update|tweak|adjust|add|make|rename|remove|delete|patch|bug|typo|font|colou?r|theme|move|replace|swap|hide|show|enable|disable|increase|decrease|darken|brighten|dim|dimmer|mute|muted|darker|lighter|brighter|edit|improve|polish|wire|connect|implement|insert|extend|expand|shorten|widen|narrow|resize|restyle|reword|rewrite|correct|repair)\b/i.test(
          askText,
        ) &&
        !redesignArtifactAsk &&
        !insistFreshBuildAsk &&
        !typedNewDeliverableAsk &&
        !regularChatBuildAsk;
      const referenceRebuildAsk =
        allowNewArtifactBuild &&
        /\b(?:exact(?:ly)?\s+clone|identical|1\s*:\s*1|recreate|clone\s+(?:this|that|it)|(?:look|make)\s+(?:it\s+)?(?:just\s+)?like\s+this|full\s+rewrite)\b/i.test(
          askText,
        ) &&
        (imageUrls.length > 0 || activeArtifactHasSource);
      const imageWebappAsk =
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        imageUrls.length > 0 &&
        detectArtifactIntent(askText, { glassScreenFirst: !!overlayAsk }) === 'webapp';
      // Same-chat open platformer + "build me a copy of minecraft like this"
      // must start a NEW coded artifact — not surgical edits of Super Coin Dash.
      const freshWebappAsk =
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        isFreshWebappBuildAsk(askText, {
          hasImages: imageUrls.length > 0,
        });
      // Open React game + visual overhaul / redesign → authorize full_rewrite on
      // the open artifact (do not force a brand-new builder unless Create is armed).
      const openReactRebuildAsk =
        !lockOutArtifactBuilds &&
        redesignArtifactAsk &&
        activeArtifactHasSource &&
        String(activeArtifact?.toolName || '') === 'lykn_build_react_artifact';
      // Open deck/doc + style rematch of THIS artifact → keep it threaded but
      // authorize full_rewrite.
      const openTemplateRestyleAsk =
        !lockOutArtifactBuilds &&
        redesignArtifactAsk &&
        activeArtifactHasSource &&
        String(activeArtifact?.toolName || '') === 'lykn_build_template' &&
        !typedNewDeliverableAsk &&
        !insistFreshBuildAsk &&
        !regularChatBuildAsk;
      const openBuilderTool = String(activeArtifact?.toolName || '');
      const sameBuilderOpen =
        activeArtifactHasSource &&
        !!artifactToolName &&
        openBuilderTool === artifactToolName;
      const differentDeliverableAsk =
        /\b(?:different|brand[- ]?new|entirely new|fresh|whole new|completely new)\s+(?:game|app|build|artifact|world|deck|site|page)\b/i.test(
          askText,
        );
      const referencePhraseAsk =
        /\b(?:like this|like that|from this|based on this|from the (?:image|screenshot|picture|reference)|as shown|in the (?:image|screenshot|picture))\b/i.test(
          askText,
        );
      // With the same builder open, broad "make/build + game/app" must NOT force
      // a fresh rebuild ("make the game harder" is a refine). Only clear NEW
      // commissions / reference rebuilds / image webapp asks wipe the panel.
      const freshWebappForcesNew =
        freshWebappAsk &&
        (!sameBuilderOpen ||
          differentDeliverableAsk ||
          referenceRebuildAsk ||
          imageUrls.length > 0 ||
          /\bcopy of\b/i.test(askText) ||
          /\b(?:from scratch|start over|brand[- ]?new|entirely new|another\s+(?:game|app)|new\s+(?:game|app)\s+entirely)\b/i.test(
            askText,
          ));
      // Clear new-build signals only. Build mode + same open artifact ⇒ refine
      // by default (edits), not a full rebuild of every add/edit ask.
      const clearFreshBuildIntent =
        referenceRebuildAsk ||
        imageWebappAsk ||
        freshWebappForcesNew ||
        openReactRebuildAsk ||
        insistFreshBuildAsk ||
        differentDeliverableAsk ||
        (typedNewDeliverableAsk && activeArtifactHasSource && !looksLikeSurgicalTweak);
      const buildModeFresh =
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        (clearFreshBuildIntent ||
          (forceArtifact &&
            artifactType === 'webapp' &&
            !activeArtifactHasSource &&
            (imageUrls.length > 0 || !looksLikeSurgicalTweak)) ||
          (forceArtifact &&
            artifactType === 'webapp' &&
            activeArtifactHasSource &&
            !sameBuilderOpen &&
            (imageUrls.length > 0 || !looksLikeSurgicalTweak)) ||
          (forceArtifact &&
            artifactType === 'webapp' &&
            sameBuilderOpen &&
            imageUrls.length > 0 &&
            (referenceRebuildAsk || freshWebappAsk || referencePhraseAsk)));
      // Force the React builder only when Create/Build is armed.
      if (
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        !artifactBuildSpec &&
        (referenceRebuildAsk || imageWebappAsk || freshWebappAsk)
      ) {
        artifactType = 'webapp';
        artifactBuildSpec = ARTIFACT_BUILD_SPEC.webapp;
        artifactToolName = artifactBuildSpec.tool;
        artifactAutoInferred = true;
        console.log(
          '🎨 Stream: fresh webapp/game ask — forcing lykn_build_react_artifact (ignoring open panel for this turn)',
        );
      }
      // Prefer refine when the OPEN artifact is the SAME builder and the user
      // is not clearly commissioning a new deliverable. Build mode stays armed
      // as sticky UI, but add/edit asks must patch the open panel — not rebuild.
      // (Still refuse to strip Create→Deck when a React game is open.)
      const preferSurgicalRefine =
        sameBuilderOpen &&
        !redesignArtifactAsk &&
        !buildModeFresh &&
        !openTemplateRestyleAsk &&
        !differentDeliverableAsk &&
        (looksLikeSurgicalTweak ||
          (forceArtifact && artifactType === 'webapp') ||
          (forceArtifact && sameBuilderOpen && !typedNewDeliverableAsk));
      if (preferSurgicalRefine && artifactBuildSpec) {
        console.log(
          `🎨 Stream: same-kind open artifact + refine ask — ignoring forceArtifact/${artifactToolName}`,
        );
        artifactBuildSpec = null;
        artifactToolName = null;
        artifactAutoInferred = false;
      } else if (activeArtifactHasSource && artifactBuildSpec && !openTemplateRestyleAsk) {
        console.log(
          `🎨 Stream: Create/Build deliverable — keeping ${artifactToolName} (not refining open "${String(activeArtifact?.title || '').slice(0, 60)}" / ${openBuilderTool || 'none'})`,
        );
        // Don't thread a different (or stale) open artifact into ARTIFACT_OPEN.
        activeArtifact = null;
      }
      // Typed new deliverable / insist-retry → force a builder ONLY when Create
      // is armed. Regular chat never starts a new artifact from wording alone.
      if (
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        !artifactBuildSpec &&
        !forceImage &&
        activeArtifactHasSource &&
        activeArtifact
      ) {
        const inferredKind = detectArtifactIntent(askText, {
          glassScreenFirst: !!overlayAsk,
        });
        const inferredSpec = inferredKind ? ARTIFACT_BUILD_SPEC[inferredKind] : null;
        const openToolNow = String(activeArtifact.toolName || '');
        const differentBuilder =
          !!inferredSpec?.tool && inferredSpec.tool !== openToolNow;
        const sameBuilderNewDeliverable =
          !!inferredSpec?.tool &&
          inferredSpec.tool === openToolNow &&
          !looksLikeSurgicalTweak &&
          !openTemplateRestyleAsk;
        if (inferredSpec && (differentBuilder || sameBuilderNewDeliverable)) {
          artifactType = inferredKind;
          artifactBuildSpec = inferredSpec;
          artifactToolName = inferredSpec.tool;
          artifactAutoInferred = true;
          activeArtifact = null;
          console.log(
            `🎨 Stream: typed ${inferredKind} intent over open ${openToolNow || 'artifact'} — forcing ${inferredSpec.tool}`,
          );
        }
      }
      if (
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        !artifactBuildSpec &&
        !forceImage &&
        typedNewDeliverableAsk
      ) {
        const inferredKind = detectArtifactIntent(askText, {
          glassScreenFirst: !!overlayAsk,
        });
        let kind = inferredKind;
        if (!kind) {
          if (/\b(?:pitch\s?deck|slide\s?deck|slide\s?show|slides?|presentation|keynote|power\s?point|ppt)\b/i.test(askText)) {
            kind = 'deck';
          } else if (/\b(?:spread\s?sheet|excel|xlsx|csv)\b/i.test(askText)) {
            kind = 'spreadsheet';
          } else if (/\b(?:study\s?guide|flash\s?cards?)\b/i.test(askText)) {
            kind = 'study';
          } else if (/\b(?:work\s?sheet|quiz|handout)\b/i.test(askText)) {
            kind = 'worksheet';
          } else if (/\b(?:web\s?apps?|web\s?sites?|landing\s?pages?|dashboards?|games?(?! ?plan)|apps?)\b/i.test(askText)) {
            kind = 'webapp';
          } else if (/\b(?:documents?|\bdocs?\b|report|essay|memo|white\s?paper)\b/i.test(askText)) {
            kind = 'document';
          }
        }
        const inferredSpec = kind ? ARTIFACT_BUILD_SPEC[kind] : null;
        if (inferredSpec) {
          artifactType = kind;
          artifactBuildSpec = inferredSpec;
          artifactToolName = inferredSpec.tool;
          artifactAutoInferred = true;
          activeArtifact = null;
          console.log(
            `🎨 Stream: typed new-deliverable (${kind}) — forcing ${inferredSpec.tool}`,
          );
        }
      }
      // Hard lock: regular chat + exclusive modes never leave a forced NEW builder armed.
      if (!allowNewArtifactBuild && (artifactBuildSpec || artifactToolName || artifactAutoInferred)) {
        console.log(
          `🔒 Stream: clearing forced builder (Create/Build not armed; was ${artifactToolName || artifactType || 'none'})`,
        );
        artifactBuildSpec = null;
        artifactToolName = null;
        artifactAutoInferred = false;
      }
      // Regular chat + clear "build me a …" ask + open panel: don't refine the
      // open artifact into a different deliverable — answer in chat and ask them
      // to arm Create/Build.
      if (regularChatBuildAsk && activeArtifact) {
        console.log(
          `🔒 Stream: regular chat build ask — ignoring open artifact "${String(activeArtifact.title || '').slice(0, 60)}" (switch to Create/Build)`,
        );
        activeArtifact = null;
      }
      // "you didn't build it" / "actually build it this time" — Create armed only.
      if (
        allowNewArtifactBuild &&
        !lockOutArtifactBuilds &&
        !artifactBuildSpec &&
        !forceImage &&
        insistFreshBuildAsk &&
        activeArtifactHasSource &&
        activeArtifact
      ) {
        const openToolNow = String(activeArtifact.toolName || '');
        const kindFromTool =
          openToolNow === 'lykn_build_template'
            ? 'deck'
            : openToolNow === 'lykn_build_spreadsheet'
              ? 'spreadsheet'
              : openToolNow === 'lykn_build_react_artifact'
                ? 'webapp'
                : openToolNow === 'lykn_manage_file'
                  ? 'document'
                  : null;
        const inferredKind =
          detectArtifactIntent(askText, { glassScreenFirst: !!overlayAsk }) || kindFromTool;
        const inferredSpec = inferredKind ? ARTIFACT_BUILD_SPEC[inferredKind] : null;
        if (inferredSpec || openToolNow) {
          artifactType = inferredKind || artifactType || 'document';
          artifactBuildSpec = inferredSpec || {
            tool: openToolNow,
            label: 'artifact',
            templateType: activeArtifact.templateType || null,
          };
          artifactToolName = artifactBuildSpec.tool;
          artifactAutoInferred = true;
          activeArtifact = null;
          console.log(
            `🎨 Stream: insist-fresh-build over open ${openToolNow || 'artifact'} — forcing ${artifactToolName}`,
          );
        }
      }
      // "can you build me something" — they commissioned a build with no kind
      // and no topic. Forcing the React builder used to invent a mini-game.
      const vagueBuildAsk =
        !forceImage &&
        !lockOutArtifactBuilds &&
        artifactBuildIntent.isVagueBuildAsk(askText);
      if (vagueBuildAsk) {
        if (artifactBuildSpec || artifactToolName) {
          console.log(
            '🎨 Stream: vague build ask — asking what to build instead of inventing a deliverable',
          );
        }
        artifactBuildSpec = null;
        artifactToolName = null;
        artifactAutoInferred = false;
      }
      // Style rematch of the OPEN template: keep it editable but authorize a
      // full sections rewrite (allowFullRewrite below).
      const activeArtifactEditable =
        Boolean(activeArtifact) &&
        activeArtifactHasSource &&
        !artifactBuildSpec &&
        !buildModeFresh &&
        !vagueBuildAsk;
      // Chat-bar "+" → Projects: a LYKN project the user explicitly scoped this
      // chat to. Unlike `projectId` (which can be a board-linked Omnia project),
      // this is always a `lykn_projects` row, so we load its [CURRENT_PROJECT]
      // context directly and even on otherwise-cheap turns.
      const scopedProjectId = (String(req.body?.scopedProjectId || '').trim() || null);
      // useTools — when true (and the resolved model is OpenAI-capable),
      // route this turn through the chat agent loop in chat-agent-loop.js
      // so the model can call lykn_listProjects / etc. via function-calling.
      // Falls through to the legacy single-shot stream when false.
      // `let` (not const) because we may downgrade this to `false` once
      // we've classified the turn — see the 'none' tier gate below.
      let useTools = req.body?.useTools === true && CHAT_TOOLS.length > 0;
      /** undefined = full in-app whitelist; array = custom-model subset */
      let streamChatToolNames;
      // Local Mode — the desktop app sets this true when the user flipped the
      // Vault switch. Local tools (file / terminal) execute client-side in the
      // Electron main process; the server only ships the schemas and relays the
      // result. Ignored unless tools are on for the turn.
      const streamLocalMode = req.body?.localMode === true;
      if (streamLocalMode) console.log('🖥️ Stream: Local Mode armed (desktop client)');
      /** True when first-party disclosure attached a small tool set (slim guidance). */
      let streamLeanToolSet = false;
      let streamDisclosure = null;
      let mcpChatTools = [];
      let mcpTurn = null;
      let model = normalizedModel;
      console.log('[LYKN-STREAM] workspaceContext received:', workspaceContext ? `${String(workspaceContext).length} chars` : 'EMPTY/MISSING');

      if (!model) return res.status(400).json({ error: 'Missing model parameter' });
      if (!prompt && text) prompt = `Answer the user's question clearly.\nQuestion:\n${text}\n`;
      if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

      // SECURITY (Agent 04): strip tool-call & system-prompt injection syntax
      // from EVERY user-controlled string before it enters the prompt builder
      // and the agent loop. Applied to:
      //   • top-level fields (text, prompt, userPrompt)
      //   • each conversation[i].content (a prior turn full of injection
      //     syntax is just as risky as a fresh message — the agent loop sees
      //     it on every hop)
      //   • workspaceContext / knowledgeBase / context / conversationMemory
      //     (server-assembled but contain user-typed vault/project text;
      //     defense in depth against vault-roundtrip injection)
      // SECURITY (Agent 06): bundled into one helper that emits one
      // INJECTION_STRIPPED event per request when fragments are stripped.
      {
        const _bundle = sanitizePromptBundle({
          req,
          fields: { text, prompt, userPrompt, context, knowledgeBase, workspaceContext, conversationMemory },
          turns: conversation,
          route: '/api/ai/stream',
        });
        text              = _bundle.fields.text;
        prompt            = _bundle.fields.prompt;
        userPrompt        = _bundle.fields.userPrompt;
        context           = _bundle.fields.context;
        knowledgeBase     = _bundle.fields.knowledgeBase;
        workspaceContext  = _bundle.fields.workspaceContext;
        conversationMemory = _bundle.fields.conversationMemory;
        conversation      = _bundle.turns;
      }

      // Regular chat live lookup — same as Glass. Do not lock exclusive Web
      // mode (that stays composerMode === 'web'). Skip image/translate lanes.
      if (
        !forceWebSearch &&
        !deepResearch &&
        !forceImage &&
        !translateMode &&
        exclusiveComposerMode !== 'image' &&
        exclusiveComposerMode !== 'translate' &&
        webSearchIntent.shouldForceWebSearch(String(text || ''), { conversation })
      ) {
        forceWebSearch = true;
        console.log('🔍 Stream: auto-armed live web search (regular chat freshness / explicit ask)');
      }

      // SECURITY (Agent 04): hard ceiling on combined user-controlled input.
      // Defense-in-depth on top of the 1MB express.json() limit and the
      // existing AI_BUDGETS per-section truncation downstream.
      const _userInputLen = (text?.length || 0) + (prompt?.length || 0) + (userPrompt?.length || 0);
      if (_userInputLen > MAX_USER_INPUT_CHARS) {
        return res.status(400).json({ error: 'prompt_too_large' });
      }

      // Enforce the caller's plan tier. If they request a model their plan
      // doesn't cover, downgrade to the best model they can use and surface an
      // `X-Model-Downgraded` header so the client can nudge them to upgrade.
      _ck('before resolveUserPlan');
      const streamPlan = await resolveUserPlan(req.user?.id, req.user?.email);
      _ck('after resolveUserPlan');
      if (!isModelAllowedForPlan(model, streamPlan.modelTier)) {
        const downgraded = defaultModelForTier(streamPlan.modelTier);
        console.log(`🔒 Model ${model} locked for plan ${streamPlan.planId} — downgrading to ${downgraded}`);
        res.setHeader('X-Model-Downgraded', `${model}->${downgraded}`);
        res.setHeader('X-Plan', streamPlan.planId);
        model = downgraded;
      }
      const streamCustomModelId = CUSTOM_MODELS_ENABLED
        ? String(req.body?.customModelId || '').trim() || null
        : null;
      const streamChatAgentCtx = null;
      let streamCustomModelCtx = { overlay: null, model, customModel: null };
      let streamOrchestrationCtx = null;
      if (streamCustomModelId && req.user?.id) {
        streamCustomModelCtx = await loadCustomModelForChat(
          req.user.id,
          streamCustomModelId,
          model,
          streamPlan.modelTier,
        );
        model = streamCustomModelCtx.model;
        if (streamCustomModelCtx.customModel) {
          try {
            res.setHeader('X-Custom-Model', streamCustomModelCtx.customModel.id);
            res.setHeader('X-Custom-Model-Name', streamCustomModelCtx.customModel.name || '');
          } catch { /* ignore */ }
        }
        if (streamCustomModelCtx.overlay?.responseLength) {
          responseLength = streamCustomModelCtx.overlay.responseLength;
        }
        if (streamCustomModelCtx.customModel && !(streamCustomModelCtx.overlay?.promptSections?.length)) {
          console.warn(
            `⚠️ Custom model ${streamCustomModelId} loaded but prompt overlay is empty (status=${streamCustomModelCtx.customModel.status})`,
          );
        }
        const mainModel = streamCustomModelCtx.customModel;
        if (mainModel && readIsMainAgent(mainModel) && supabaseAdmin) {
          const subModelIds = readSubModelIds(mainModel);
          const roster = await loadSubModelRoster(supabaseAdmin, req.user.id, subModelIds);
          if (roster.length) {
            const [activeTasks, completedReports] = await Promise.all([
              listSubModelTasks(supabaseAdmin, req.user.id, {
                mainModelId: mainModel.id,
                status: 'pending,running',
                limit: 12,
              }),
              listUndeliveredCompletedTasks(supabaseAdmin, req.user.id, mainModel.id),
            ]);
            streamOrchestrationCtx = {
              isMainAgent: true,
              mainModelId: mainModel.id,
              subModelIds: roster.map((r) => r.id),
              roster,
              activeTasks,
              completedReports,
              orchestrationBlock: formatMainAgentOrchestrationBlock(mainModel, roster, {
                activeTasks,
                completedReports,
              }),
            };
            console.log(
              `🎯 Main agent "${mainModel.name}" orchestrating ${roster.length} sub-model(s)` +
                (activeTasks.length ? ` (${activeTasks.length} active task(s))` : '') +
                (completedReports.length ? ` (${completedReports.length} new report(s))` : ''),
            );
          }
        }
      }

      const streamBoundProjectId =
        readCustomModelLinkedProjectId(streamCustomModelCtx.customModel) ||
        (String(projectId || '').trim() || null);
      const streamBoardProjectId =
        !readCustomModelLinkedProjectId(streamCustomModelCtx.customModel)
          ? (String(projectId || '').trim() || null)
          : null;

      if (streamChatAgentCtx?.agent) {
        const toolsCfg = streamChatAgentCtx.toolsCfg;
        streamChatToolNames = toolsCfg.toolNames;
        useTools = toolsCfg.enabled && toolsCfg.toolNames.length > 0;
        console.log(
          useTools
            ? `🛠 Chat agent "${streamChatAgentCtx.agent.name}" tools: ${toolsCfg.toolNames.length}`
            : `🛠 Chat agent "${streamChatAgentCtx.agent.name}" tools: off`,
        );
      } else if (streamCustomModelCtx.customModel) {
        const toolsCfg = resolveCustomModelChatTools(streamCustomModelCtx.customModel.metadata);
        streamChatToolNames = toolsCfg.toolNames;
        useTools = toolsCfg.enabled && toolsCfg.toolNames.length > 0;
        if (useTools) {
          console.log(
            `🛠 Custom model "${streamCustomModelCtx.customModel.name}" agent tools: ${toolsCfg.toolNames.length}`,
          );
        } else {
          console.log(
            `🛠 Custom model "${streamCustomModelCtx.customModel.name}" agent tools: off`,
          );
        }
      }
      if (streamOrchestrationCtx?.isMainAgent) {
        const names = Array.isArray(streamChatToolNames) ? [...streamChatToolNames] : [];
        // Main agents always get the orchestration trio (delegate/list/get) AND
        // live web reach (search + fetch). The default LYKN chat already has web
        // tools via the full whitelist; a CUSTOM main agent's tool set is gated
        // to what the user toggled in Model Builder, so an orchestrator could be
        // unable to "go research this online" for the user. Force these on so
        // every main agent can browse and scrape, mirroring the delegation tools.
        for (const toolName of [
          'lykn_delegate_to_sub_model',
          'lykn_list_sub_model_tasks',
          'lykn_get_sub_model_task',
          'lykn_web_search',
          'lykn_web_fetch',
        ]) {
          if (!names.includes(toolName)) names.push(toolName);
        }
        streamChatToolNames = names;
        useTools = useTools || names.length > 0;
        console.log('🎯 Main agent delegation + web tools enabled');
      }
      const brainstormBuildMention =
        !forceArtifact &&
        artifactBuildIntent.isHypotheticalOrBrainstormBuildMention(String(text || ''));
      const customToolsOff = Boolean(
        (streamChatAgentCtx?.agent || streamCustomModelCtx.customModel) &&
        !useTools &&
        !forceImage &&
        !artifactToolName &&
        !activeArtifactEditable,
      );
      if (!customToolsOff) {
        const ceiling = Array.isArray(streamChatToolNames) ? [...streamChatToolNames] : null;
        streamDisclosure = resolveChatTurnDisclosure({
          message: String(text || ''),
          conversation,
          exclusiveComposerMode,
          deepResearch,
          translateMode,
          forceImage,
          forceArtifact,
          forceWebSearch,
          forcePageFetch,
          pageUrl: overlayPageUrl,
          overlayAsk: !!overlayAsk,
          artifactToolName,
          activeArtifactEditable,
          activeArtifactTool: activeArtifact?.toolName,
          inProject: Boolean(
            scopedProjectId ||
            String(projectId || '').trim() ||
            readCustomModelLinkedProjectId(streamCustomModelCtx.customModel),
          ),
          localMode: streamLocalMode,
          allowNewArtifactBuild,
          lockOutArtifactBuilds,
          brainstormBuildMention,
          vagueBuildAsk,
          agentBrowser: Boolean(agentMode || toolDraft || req.body?.ownedBrowser === true),
          ceilingToolNames: ceiling,
        });
        streamChatToolNames = streamDisclosure.firstPartyToolNames;
        if (streamOrchestrationCtx?.isMainAgent) {
          for (const toolName of [
            'lykn_delegate_to_sub_model',
            'lykn_list_sub_model_tasks',
            'lykn_get_sub_model_task',
          ]) {
            if (!streamChatToolNames.includes(toolName)) streamChatToolNames.push(toolName);
          }
        }
        streamLeanToolSet = streamDisclosure.useSlimGuidance;
        if (streamDisclosure.keepToolsOn) useTools = true;
        if (streamDisclosure.exclusive && streamChatToolNames.length === 0) {
          useTools = false;
          console.log('🔒 Stream: exclusive mode — empty tool allowlist');
        }
        const inspect = streamDisclosure.inspect || {};
        console.log(
          `🧭 Stream: first-party disclosure capabilities=${(streamDisclosure.capabilities || []).join(',') || '(none)'} ` +
            `tools=${inspect.count ?? streamChatToolNames.length} bytes=${inspect.bytes ?? 0} ~${inspect.approxTokens ?? 0} tokens` +
            (streamDisclosure.fallback && streamDisclosure.fallback !== 'none'
              ? ` fallback=${streamDisclosure.fallback}`
              : ''),
        );
      }

      if (
        req.user?.id &&
        streamDisclosure &&
        !forceImage &&
        !translateMode &&
        exclusiveComposerMode !== 'image' &&
        exclusiveComposerMode !== 'translate'
      ) {
        try {
          mcpTurn = await resolveMcpToolsForTurn({
            manager: getMcpManager(supabaseAdmin),
            userId: req.user.id,
            text: String(text || ''),
            botConnectionIds: undefined,
            connectionIds: undefined,
          });
          if (mcpTurn.tools.length) {
            const bound = bindMcpChatHandlers(mcpTurn.tools, mcpTurn.bindings, {
              manager: getMcpManager(supabaseAdmin),
              userId: req.user.id,
              text: String(text || ''),
            });
            const composed = composeWithExternalTools(
              Array.isArray(streamChatToolNames) ? streamChatToolNames : [],
              bound,
            );
            mcpChatTools = composed.externalTools;
            streamChatToolNames = composed.toolNames;
            streamDisclosure = {
              ...streamDisclosure,
              externalTools: composed.externalTools,
              toolNames: composed.toolNames,
              keepToolsOn: composed.firstPartyToolNames.length > 0 || composed.externalTools.length > 0,
            };
            if (streamDisclosure.keepToolsOn) useTools = true;
            console.log(`🔌 Stream: MCP tools (${mcpChatTools.length}): ${mcpChatTools.map((t) => t.name).join(', ')}`);
          }
        } catch (e) {
          console.warn('⚠️ mcp turn resolve skipped:', e?.message || e);
        }
      }

      // Custom AI instructions are Studio+. Strip them for basic-tier callers.
      if (streamPlan.modelTier === 'basic' && userPrompt) {
        userPrompt = undefined;
        res.setHeader('X-Feature-Stripped', 'user_prompt');
      }

      // ── Open the SSE response NOW, before any pre-flight work ─────────
      // Previously we delayed `res.writeHead`/`flushHeaders` until after
      // prompt construction + the enrichment Promise.all + the model
      // resolver. For a "no enrichment" turn that's fine, but the moment
      // the first model attempt hits a 429/overload (gemini-3-flash-preview
      // is doing this constantly mid-2026) the failover to the next
      // provider eats another 1-3s of pre-headers time. The client sees
      // *zero bytes* during all of that and the chat appears frozen.
      //
      // By flushing the SSE headers up front we:
      //   1. Let the browser render its "stream open" state immediately
      //      (rules out "is the network even working?" perception).
      //   2. Can push `data: {"status":"…"}` heartbeats during pre-flight
      //      so the existing client-side `chatStatusText` shows progress.
      //   3. Eliminate the worst case where headers never arrive because
      //      every model in the chain failed — clients get a clean error
      //      event over the open stream instead of a hung request.
      //
      // No `res.status()`/`res.json()` calls fire between here and the
      // actual stream write loop, so flushing now is safe. The only late
      // `res.setHeader` in this route (X-Smart-Route at the Pro→Flash
      // auto-downgrade below) is wrapped in try/catch to silently no-op
      // once headers are already sent — those headers are diagnostic only
      // and the client doesn't read them.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      if (req.socket) req.socket.setNoDelay(true);
      // SECURITY (Agent 04): drop stuck streams after 3 minutes (5 for deep
      // research). Without this, a client that opens an SSE connection and never
      // closes it pins the socket indefinitely — slow connection-table
      // exhaustion is a DoS vector that aiLimiter (per-user) doesn't catch
      // (one user, many hung connections under the 30/min ceiling).
      const streamIdleTimeoutMs = deepResearch ? 300_000 : 180_000;
      try { req.setTimeout?.(streamIdleTimeoutMs, () => { try { res.end(); } catch { /* socket already closed */ } }); } catch { /* req.setTimeout missing on some test transports */ }
      const streamAbort = new AbortController();
      const onStreamClose = () => {
        try { streamAbort.abort(); } catch { /* ignore */ }
      };
      try { req.on('close', onStreamClose); } catch { /* ignore */ }
      const writeStreamStatus = (status) => {
        if (!status || res.writableEnded) return;
        try {
          res.write(`data: ${JSON.stringify({ status: String(status) })}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        } catch { /* socket closed */ }
      };
      try {
        res.write(
          `data: ${JSON.stringify({
            status: deepResearch
              ? 'Planning research\u2026'
              : forceArtifact
                ? 'Designing the build\u2026'
                : 'Thinking\u2026',
          })}\n\n`,
        );
        if (typeof res.flush === 'function') res.flush();
      } catch { /* socket closed before first write — handled by stallCheck/cleanup below */ }
      _ck('SSE headers flushed + Thinking heartbeat sent');

      const streamUserText = String(text || prompt || '').trim();
      const streamPureUserMessage = extractPureUserMessage(text, prompt);

      const kbText = (() => {
        if (!knowledgeBase) return "";
        const raw = typeof knowledgeBase === "string" ? knowledgeBase : JSON.stringify(knowledgeBase);
        const trimmed = String(raw || "").trim();
        return trimmed.length > AI_BUDGETS.projectSummary ? `${trimmed.slice(0, AI_BUDGETS.projectSummary)}…` : trimmed;
      })();

      const buildLyknStreamPrompt = (input) => {
        const fullPrompt = String(input?.prompt || "").trim();
        const userMsg = String(input?.text || "").trim().slice(0, AI_BUDGETS.userPrompt);

        // Tier 3 cost cuts (mirrors buildLyknChatPrompt above):
        //  1. Static persona is module-level (`LYKN_STREAM_PERSONA_FULL`),
        //     producing a stable sha256 so Gemini cachedContents hits ~every call.
        //  2. Workspace context is intent-gated — only embed when the user
        //     explicitly asks about Vault / cross-board / saved content.
        //  3. Board context cap drops from 14K → 4K when the user has focused
        //     bricks; the focused bricks ARE the target, no need for the rest.
        //  4. All boolean toggles (hasProject / hasFocusedBricks / image vision
        //     / DETAILED_VAULT) live in the dynamic side now, not the persona.
        const hasFocusedBricks = Boolean(input?.hasFocusedBricks);
        const wsCtxRaw = String(input?.workspaceContext || "").trim();
        // Image-only turns must not see Vault listings — the model was dumping
        // random saved notes after a successful generate.
        const includeWsCtx =
          wsCtxRaw &&
          !input?.forceImage &&
          shouldEmbedWorkspaceContext(userMsg);
        const wsCtx = includeWsCtx
          ? wsCtxRaw.slice(0, AI_BUDGETS.workspaceContext)
          : "";
        const ctxBudget = hasFocusedBricks ? BOARD_CONTEXT_FOCUSED_CHARS : AI_BUDGETS.canvasTotal;
        const ctx = String(input?.context || "").trim().slice(0, ctxBudget);
        const kbBudget = input?.projectId ? AI_BUDGETS.projectSummaryInProject : AI_BUDGETS.projectSummary;
        const kb = String(input?.knowledgeBase || "").trim().slice(0, kbBudget);
        const convo = compressConversation(input?.conversation);
        const conversationMemoryText =
          input?.forceImage
            ? ''
            : input?.conversationMemory
              ? String(input.conversationMemory).slice(0, 6000)
              : '';

        const focusedBricksNote = "";

        const imageNote = imageUrls.length > 0
          ? `[ATTACHED_IMAGES]\n${imageUrls.length} image(s) attached as actual pixel data — describe / reference them as needed.`
          : "";

        const userPromptSection =
          input?.userPrompt && String(input.userPrompt).trim()
            ? `[USER_PREFERENCES]\nThe user has set these personal instructions — always follow them:\n${String(input.userPrompt).trim().slice(0, AI_BUDGETS.userPrompt)}`
            : '';

        // The Settings → Chat response-length choice. This was read off the
        // request but never reached the streamed prompt, so Concise / Balanced /
        // Detailed all produced the same clipped replies. Skipped for Glass
        // overlay asks and forced image turns, where reply length is not the
        // user-facing product.
        const responseLengthSection =
          input?.overlayAsk || input?.forceImage || agentMode
            ? ''
            : buildResponseLengthNote(responseLength);

        // Studio mode session (Build / Imagine / Research page in LYKN Studio):
        // the client ships the mode's system prompt on every turn while the
        // session is active so the whole conversation stays in-lane.
        const activeModeSection =
          input?.modeInstructions && String(input.modeInstructions).trim()
            ? `[ACTIVE_MODE]\n${String(input.modeInstructions).trim().slice(0, 2000)}`
            : '';

        const assistantIdentitySection = buildAssistantIdentitySection(input?.aiName);

        // The apps the user built in LYKN. They live in the local store on the
        // user's machine, so this list is the only way the model knows they
        // exist — without it, "open my workout tracker" has nothing to match.
        const installedAppsSection = buildInstalledAppsSection(input?.installedApps);

        // What they have on their Mac — the difference between opening Spotify
        // and opening spotify.com.
        const macAppsSection = buildMacAppsSection(input?.macApps);

        // What LYKN has already built for them, in AI Drive. Same problem the
        // app list solves: they say "open the one you made me" and the model
        // needs a name to match.
        const aiDriveSection = buildAiDriveSection(input?.aiDrive, input?.aiDriveTotals);

        // Slim system blocks for ChatGPT-fast turns (no full persona / learned-tag
        // tax). Glass always slims; in-app slims on ordinary Q&A (input.fastLean).
        // Vault/project/recall/tool turns keep the full persona.
        const streamStaticPersona = streamCustomModelCtx.customModel
          ? getCustomModelStreamPersonaFull(LYKN_MEMORY_WRITE_INSTRUCTIONS)
          : input?.overlayAsk
            ? LYKN_GLASS_STREAM_PERSONA_SLIM
            : input?.fastLean
              ? LYKN_CHAT_STREAM_PERSONA_SLIM
              : LYKN_STREAM_PERSONA_FULL;

        return [
          // Static persona — LYKN default or custom-model runtime + learn-a-fact.
          streamStaticPersona,

          // Dynamic per-call sections (treated as 'user' content by
          // splitPromptForProvider — uncached, varies per call).
          assistantIdentitySection,
          userPromptSection,
          responseLengthSection,
          activeModeSection,
          installedAppsSection,
          macAppsSection,
          aiDriveSection,
          focusedBricksNote,
          imageNote,
          convo ? `[CONVERSATION — each line shows role, timestamp, and (for assistant) which model wrote it. Prior assistant lines are from other models, not you.]\n${convo}` : "",
          conversationMemoryText
            ? `[CONVERSATION_MEMORY — past exchanges from other projects/vault]\n${sanitizeStaleSurfaceLanguage(conversationMemoryText)}`
            : '',
          wsCtx ? `[WORKSPACE_CONTEXT]\n${wsCtx}` : "",
          fullPrompt && fullPrompt !== userMsg ? `[FULL_CONTEXT]\n${fullPrompt.slice(0, 16000)}` : "",
          kb ? `[WHAT_IM_ON]\n[PROJECT_KNOWLEDGE]\nProject knowledge for the active focus — connect the screen / topic here when it fits.\n${kb}` : "",
          ctx ? `[CONTEXT]\n${ctx}` : "",
          `[USER]\n${userMsg}`,
        ].filter(Boolean).join("\n\n");
      };

      const normalizedIntent = String(intent || "").trim().toLowerCase();
      const isChatIntent = normalizedIntent === "ask" || normalizedIntent === "chat" || normalizedIntent === "question";

      // ── Fast-path decisions BEFORE prompt build ──────────────────────
      // Tool schemas + full persona + enrichment used to run on every turn.
      // Decide lean/tools first so ordinary Q&A gets a slim persona and skips
      // DB/embed round-trips entirely (ChatGPT-fast TTFT).
      const userText = String(text || prompt || "");
      const streamSearchText = streamPureUserMessage || userText;
      const hasContextForStreamSearch = Boolean(context) || Boolean(knowledgeBase) || Boolean(workspaceContext);
      const streamEnrichTier = !isChatIntent
        ? 'none'
        : classifyEnrichment(streamPureUserMessage || text, { hasFocusedBricks: Boolean(hasFocusedBricks), hasContext: hasContextForStreamSearch, conversation });
      if (streamEnrichTier === 'none') console.log('⚡ Stream: No enrichment — simple query / non-chat');
      else if (streamEnrichTier === 'light') console.log('💡 Stream: Light enrichment — lean memory only (no web)');
      else console.log('🔬 Stream: Full enrichment — web search / URL scraping');

      const streamHasProjectWriteScope = Boolean(streamBoundProjectId || streamBoardProjectId);
      let streamEnrichTierEffective = streamEnrichTier;

      // CASUAL-TURN TOOL GATE: on a 'none' tier (greetings, casual chitchat,
      // identity-of-LYKN questions, single-word acks), turn off the agent
      // loop entirely. Project tools are also stripped unless the chat is
      // scoped or the user asked — but phatic turns still don't need any
      // tools, so skip the loop entirely for a clean conversational reply.
      //
      // Exception: custom models linked to a project (or board-scoped chat)
      // must keep tools enabled so lykn_pushProjectState can run on short
      // confirmations ("yes", "ship it") — otherwise the project panel
      // stays empty while the model claims it saved working memory.
      // Local Mode asks ("what's in my downloads folder", "run npm install")
      // don't look like agent-tool intent to the casual/lean heuristics below,
      // but they need the tool loop so the local file/terminal tools get
      // offered. Only computed when the desktop sent localMode: true.
      const streamLocalIntent =
        streamLocalMode &&
        (looksLikeLocalSystemAsk(streamPureUserMessage || text) ||
          // Browser-shaped asks must keep their tools too, so the MODEL gets to
          // decide whether to call local_browser_agent. Loose on purpose — a
          // false positive only means schemas ride along on one turn.
          mightBeBrowserTaskAsk(streamPureUserMessage || text));
      if (streamLocalIntent) {
        console.log('🖥️ Stream: local-mode ask detected — keeping tools on');
      }
      if (useTools && streamEnrichTier === 'none') {
        if (streamLocalIntent) {
          streamEnrichTierEffective = 'light';
          console.log('🖥️ Stream: local-mode ask — keeping tools on despite casual tier');
        } else if (forceImage) {
          streamEnrichTierEffective = 'light';
          console.log('🖼 Stream: forced image generation — keeping tools on despite casual tier');
        } else if (artifactToolName) {
          streamEnrichTierEffective = 'light';
          console.log(`🎨 Stream: forced artifact build (${artifactType}) — keeping tools on despite casual tier`);
        } else if (activeArtifactEditable) {
          streamEnrichTierEffective = 'light';
          console.log('🎨 Stream: artifact open for editing — keeping tools on despite casual tier');
        } else if (streamHasProjectWriteScope) {
          streamEnrichTierEffective = 'light';
          console.log('📌 Stream: project-scoped chat — keeping tools on (light enrichment) despite casual tier');
        } else if (AGENTS_APPS_CODE_INTENT_RE.test(String(streamPureUserMessage || text || ''))) {
          streamEnrichTierEffective = 'light';
          console.log('🛠 Stream: code/build/app/agent intent — keeping tools on despite casual tier');
        } else if (deepResearch || forceWebSearch) {
          streamEnrichTierEffective = deepResearch ? 'full' : 'light';
          console.log(
            deepResearch
              ? '🔬 Stream: deep research armed — keeping tools on + full enrichment'
              : '🔍 Stream: forced web search — keeping tools on despite casual tier',
          );
        } else if (forcePageFetch) {
          streamEnrichTierEffective = 'light';
          console.log('🌐 Stream: full-page fetch armed — keeping tools on despite casual tier');
        } else {
          useTools = false;
          console.log('💬 Stream: useTools disabled for casual turn — skipping agent loop and project-proposal guidance');
        }
      }
      // Glass "thanks" / "gotcha" — never worth vault/project/tool hops.
      if (
        useTools &&
        overlayAsk &&
        !forceImage &&
        !artifactToolName &&
        !activeArtifactEditable &&
        isCasualOverlayAck(streamPureUserMessage || text)
      ) {
        useTools = false;
        console.log('🪟 Stream: useTools disabled for Glass casual ack');
      }
      // Lean ChatGPT-fast path: skip the agent loop unless this turn actually
      // needs a disclosed tool. Simple chat stays at 0 schemas.
      const streamActionIntent = messageWantsAgentTools(streamPureUserMessage || text, {
        forceImage,
        forceWebSearch,
        deepResearch,
        forcePageFetch,
        conversation,
        artifactToolName,
        activeArtifactEditable,
        inProject: Boolean(
          scopedProjectId ||
          streamBoundProjectId ||
          readCustomModelLinkedProjectId(streamCustomModelCtx.customModel),
        ),
      });
      if (
        useTools &&
        !streamActionIntent &&
        !streamLocalIntent &&
        !streamDisclosure?.keepToolsOn &&
        !forceImage &&
        !artifactToolName &&
        !activeArtifactEditable &&
        !streamChatAgentCtx?.agent &&
        !streamCustomModelCtx.customModel
      ) {
        useTools = false;
        console.log('⚡ Stream: lean path — tools off (no action intent; skip tool schemas + guidance)');
      }
      if (
        useTools &&
        Array.isArray(streamChatToolNames) &&
        streamChatToolNames.length === 0 &&
        !(streamDisclosure?.externalTools?.length)
      ) {
        useTools = false;
        console.log('⚡ Stream: no disclosed tools — skipping agent loop');
      }

      const streamOverlayMsg = streamPureUserMessage || streamSearchText || '';
      const streamOverlayWantsSaved = messageWantsSavedRecall(streamOverlayMsg);
      const streamInProject = Boolean(
        scopedProjectId ||
        streamBoundProjectId ||
        readCustomModelLinkedProjectId(streamCustomModelCtx.customModel),
      );
      const streamWantsProject = messageWantsProjectContext(streamOverlayMsg);
      const streamMsgEarly = streamPureUserMessage || streamSearchText || '';
      const streamWantsPureGreeting = messageIsPureGreeting(streamMsgEarly) && !scopedProjectId;
      const streamUserRecallMode = streamWantsPureGreeting
        ? null
        : resolveUserRecallMode(streamMsgEarly, conversation);
      const streamWantsUserRecall = streamUserRecallMode != null;
      const streamWantsUserRecallDeepen = streamUserRecallMode === 'deepen';
      // Fast lean = ordinary Q&A with no tools/project/recall/vault. Slim persona
      // + zero enrichment DB hits. Applies to BOTH in-app chat and Glass.
      const streamFastLean =
        !useTools &&
        !forceImage &&
        !artifactToolName &&
        !activeArtifactEditable &&
        !scopedProjectId &&
        !streamInProject &&
        !streamWantsProject &&
        !streamOverlayWantsSaved &&
        !streamWantsUserRecall &&
        !streamCustomModelCtx.customModel &&
        !streamChatAgentCtx?.agent &&
        !deepResearch &&
        !forceWebSearch;
      if (streamFastLean) {
        console.log(overlayAsk
          ? '⚡ Stream: Glass fast-lean — slim persona, no enrichment'
          : '⚡ Stream: chat fast-lean — slim persona, no enrichment');
      }
      const streamNeedsPersonalMemory =
        streamWantsUserRecall ||
        (streamInProject && !useTools) ||
        (Boolean(overlayAsk) && !streamFastLean && !useTools && !streamOverlayWantsSaved);
      // Glass/in-app lean + tool-only turns: no memory round-trips.
      const streamSkipUserFacts =
        (!isChatIntent && !overlayAsk) ||
        streamFastLean ||
        streamWantsPureGreeting ||
        (!streamNeedsPersonalMemory && !streamWantsUserRecall);

      if (isChatIntent) {
        _ck('before buildLyknStreamPrompt');
        prompt = buildLyknStreamPrompt({
          prompt,
          text,
          context,
          knowledgeBase: kbText,
          workspaceContext,
          conversation,
          conversationMemory,
          userPrompt,
          aiName,
          projectId,
          intent: normalizedIntent || 'ask',
          hasFocusedBricks: Boolean(hasFocusedBricks),
          overlayAsk: Boolean(overlayAsk),
          fastLean: streamFastLean,
          forceImage: Boolean(forceImage) && !forceArtifact,
          modeInstructions: String(req.body?.modeInstructions || '').trim().slice(0, 2000),
          // Desktop-only, and the model's only way to know these apps exist.
          installedApps: req.body?.installedApps,
          macApps: req.body?.macApps,
          aiDrive: req.body?.aiDrive,
          aiDriveTotals: req.body?.aiDriveTotals,
        });
        _ck('after buildLyknStreamPrompt');
      }

      // Explicit URL intent overrides the tier — if the user pasted a URL and
      // asked us to read / browse / search it, we scrape regardless of tier.
      const streamExplicitUrlIntent = isChatIntent && hasExplicitUrlScrapeIntent(streamSearchText);
      if (streamExplicitUrlIntent) console.log('🔗 Stream: Explicit URL scrape intent detected — forcing scrape');
      // Pasted-URL auto-scrape: see the invoke path above for the rationale.
      // ANY URL in the current user message triggers scrape; scrapeUrlsFromText's
      // internal gating bounds the cost. isChatIntent matches the same gate
      // streamExplicitUrlIntent uses, so action / non-chat paths are excluded.
      const streamHasUrlInMessage = isChatIntent && URL_DETECT_RE.test(streamSearchText);
      if (streamHasUrlInMessage && !streamExplicitUrlIntent) console.log('🔗 Stream: Pasted URL detected — auto-scraping (no explicit intent verbs)');
      const streamSkipScrape    = !streamExplicitUrlIntent && !streamHasUrlInMessage;
      const streamSkipSearch    = (forceWebSearch || deepResearch)
        ? false
        : (skipWebSearch || streamEnrichTierEffective !== 'full');
      const streamSlimIdentity = true; // always slim when we inject identity at all
      // Projects are opt-in: only inject [WHAT_IM_ON] when the chat is scoped /
      // bound to a project, or the user explicitly asked about a project.
      const streamSkipProject =
        streamFastLean ||
        (!streamInProject && !streamWantsProject) ||
        (streamEnrichTierEffective === 'none' && !streamInProject);
      const streamSkipYouTube   = streamEnrichTierEffective === 'none' || streamFastLean || !needsYouTubeSearch(streamPureUserMessage || streamSearchText);
      _ck(`before enrichment Promise.all (tier=${streamEnrichTierEffective}, skipScrape=${streamSkipScrape}, skipSearch=${streamSkipSearch}, skipMemory=${streamSkipUserFacts}, skipYT=${streamSkipYouTube})`);
      const streamVaultUrlMatchesPromise = Promise.resolve('');
      const streamCustomModelKnowledgePromise =
        streamCustomModelCtx.customModel && req.user?.id
          ? fetchCustomModelKnowledgeSection(req.user.id, streamCustomModelCtx.customModel)
          : Promise.resolve('');
      if (streamBoundProjectId && req.user?.id && supabaseAdmin) {
        await stampActiveProject(supabaseAdmin, req.user.id, streamBoundProjectId);
      }
      let deepResearchSources = [];
      const streamSearchPromise = streamSkipSearch
        ? Promise.resolve('')
        : deepResearch
          ? (async () => {
              const topic = String(streamPureUserMessage || streamSearchText || '').trim();
              if (!topic || topic.length < 4 || messageIsPureGreeting(topic)) {
                writeStreamStatus('Thinking\u2026');
                return '';
              }
              console.log(
                `🔬 Deep research pipeline: "${topic.slice(0, 80)}" (sources=${researchSourcePref || 'all'})`,
              );
              const out = await runDeepResearchForPrompt(topic, {
                onStatus: writeStreamStatus,
                signal: streamAbort.signal,
                sourcePref: researchSourcePref,
              });
              if (out.ok && out.text) {
                deepResearchSources = (out.pack?.sources || [])
                  .filter((s) => s?.url)
                  .slice(0, 40)
                  .map((s) => ({ title: s.title || 'Source', url: s.url }));
                console.log(
                  `✅ Deep research: ${out.pack?.queries?.length || 0} queries, ` +
                    `${out.pack?.sources?.length || 0} sources, ${out.pack?.pages?.length || 0} pages`,
                );
                return out.text;
              }
              const failReason = String(out.pack?.error || 'unknown');
              console.warn(`⚠️ Deep research failed (${failReason}) — falling back to forced web search`);
              writeStreamStatus(
                failReason === 'serper_no_credits'
                  ? 'Search provider is out of credits \u2014 trying a simpler web search\u2026'
                  : 'Searching the web\u2026',
              );
              const fallbackText = await runWebSearchIfNeeded(topic, {
                hasFocusedBricks: Boolean(hasFocusedBricks),
                hasContext: hasContextForStreamSearch,
                conversation,
                force: true,
                deep: true,
              });
              if (fallbackText) {
                deepResearchSources = extractSourcesFromSearchPrompt(fallbackText);
              } else {
                writeStreamStatus('Couldn\u2019t reach live sources \u2014 writing from general knowledge.');
              }
              return fallbackText;
            })()
          : runWebSearchIfNeeded(streamSearchText, {
              hasFocusedBricks: Boolean(hasFocusedBricks),
              hasContext: hasContextForStreamSearch,
              conversation,
              force: forceWebSearch,
              deep: false,
            });
      const streamMsg = streamMsgEarly;
      const [scrapedContent, searchResults, youtubeResults, vaultUrlMatches, connectedToolsSection, projectSection, streamCustomModelKnowledge, memorySectionRaw] = await Promise.all([
        streamSkipScrape ? Promise.resolve("") : scrapeUrlsFromText(streamSearchText, { force: streamExplicitUrlIntent }),
        streamSearchPromise,
        streamSkipYouTube ? Promise.resolve("") : runYouTubeSearchIfNeeded(streamPureUserMessage || streamSearchText),
        streamVaultUrlMatchesPromise,
        Promise.resolve(""),
        !streamSkipProject
          ? fetchProjectSection(
              req.headers.authorization,
              req.user?.id,
              readCustomModelLinkedProjectId(streamCustomModelCtx.customModel) || scopedProjectId,
              { slim: streamSlimIdentity && !scopedProjectId },
            )
          : Promise.resolve({ text: '', projectId: null, neuronIds: [] }),
        streamCustomModelKnowledgePromise,
        !streamSkipUserFacts
          ? resolveProductionChatMemory({
              userId: req.user?.id,
              user: req.user,
              chatId: req.body?.chatId,
              recall: streamWantsUserRecall,
              deepen: streamWantsUserRecallDeepen,
            }).then((turn) => turn.text || "")
          : Promise.resolve(""),
      ]);
      _ck('after enrichment Promise.all');
      if (deepResearchSources.length && !res.writableEnded) {
        try {
          res.write(`data: ${JSON.stringify({ sources: deepResearchSources })}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        } catch { /* socket closed */ }
      }
      const memorySection = memorySectionRaw || "";
      if (connectedToolsSection && !streamWantsPureGreeting) prompt += "\n\n" + connectedToolsSection;
      if (streamCustomModelCtx.overlay?.beliefText) {
        prompt += "\n\n" + sanitizeStaleSurfaceLanguage(streamCustomModelCtx.overlay.beliefText);
      }
      if (projectSection?.text && !streamWantsUserRecall && !streamWantsPureGreeting) {
        prompt += "\n\n" + sanitizeStaleSurfaceLanguage(projectSection.text);
      }
      if (scopedProjectId && !streamWantsUserRecall && !streamWantsPureGreeting) {
        const scopedName = String(req.body?.scopedProjectName || '').trim();
        prompt +=
          "\n\n[ACTIVE_PROJECT_SCOPE — The user opened this chat scoped to the project" +
          (scopedName ? ` "${scopedName}"` : " shown in [WHAT_IM_ON] above") +
          ". This project is the active working context for the ENTIRE conversation, not just one turn. " +
          "In your FIRST reply you MUST name this project and make clear you're working inside it, then orient around it — what's already in it and what they want to do with it — using [WHAT_IM_ON] above for specifics. " +
          "This overrides the default greeting style: do NOT send a generic greeting that ignores the project. " +
          "If [WHAT_IM_ON] shows no saved state or clustered context yet, say the project looks empty so far and offer to help start filling it in.]";
      }
      if (deepResearch) {
        const evidence = String(searchResults || '');
        if (evidence.includes('[DEEP_RESEARCH_EVIDENCE]')) {
          // Report structure + Sources rules are inside the evidence pack.
          prompt +=
            '\n\n[RESEARCH_MODE — Deep research is armed. Treat [DEEP_RESEARCH_EVIDENCE] as your primary evidence and follow [RESEARCH_REPORT_INSTRUCTIONS]. ' +
            'Deliver the report as markdown in your reply ONLY. Do NOT call lykn_build_*, open a side-panel artifact, ' +
            'or "build a polished interactive report". Mentions of investor pitch / deck / slides are the TOPIC of this ' +
            'written research — not a Create/Build request. The user armed Deep research, not Create.]';
        } else if (evidence.includes('[WEB_SEARCH_RESULTS]')) {
          prompt +=
            '\n\n[RESEARCH_MODE — Deep research is armed. Multi-query research was unavailable, so use [WEB_SEARCH_RESULTS] as your evidence. ' +
            'Write a thorough markdown report in your reply ONLY and end with a **Sources** section listing markdown links ONLY from those results — never invent URLs. ' +
            'Do NOT call lykn_build_* or create a side-panel artifact.]';
        } else {
          prompt +=
            '\n\n[RESEARCH_MODE — Deep research was requested but live multi-source evidence was unavailable. ' +
            'Say so briefly, answer carefully from general knowledge with clear uncertainty, and do not invent URLs or a fake Sources list. ' +
            'Do NOT fall back to building an interactive artifact or pitch deck.]';
        }
      }
      if (translateMode) {
        const targetLang = String(req.body?.translateTargetLang || '').trim().slice(0, 64);
        prompt += targetLang
          ? `\n\n[TRANSLATE_MODE — Translate mode is armed. Target language: ${targetLang}. ` +
            `Do not ask which language — it is already chosen. ` +
            `If the user typed/dictated text to translate, translate that into ${targetLang}. ` +
            `If they ask to translate the screen/page (or sent little/no text), translate all readable ` +
            `on-screen or page text from the screenshot/page context into ${targetLang}. ` +
            `Lead with the translation; keep commentary minimal unless they ask.]`
          : '\n\n[TRANSLATE_MODE — Translate mode is armed. Translate typed/dictated text, or on-screen/page ' +
            'content when they ask to translate the screen (or send little/no text), into the target language they name. ' +
            'If no target language is given, ask once briefly. Lead with the translation; keep commentary minimal unless they ask.]';
      }
      if (regularChatBuildAsk) {
        prompt +=
          '\n\n[REGULAR_CHAT — Create/Build mode is NOT armed. Do NOT build a deck, app, document, chart, ' +
          'or any side-panel artifact. If the user is asking you to build something, briefly say you can do that ' +
          'once they switch into Build (Glass) or Create ("+" menu) and resend. If they were brainstorming or ' +
          'asking a product question, answer that in conversation without building.]';
      }
      // Glass: when they ask about more of the open site than the screenshot, fetch
      // the known tab URL server-side — but skip if Electron already scroll-scraped
      // rich page text (SPA shells like lykn.io return empty HTML over HTTP).
      const electronPageTextRich = req.body?.pageTextRich === true;
      if (
        overlayAsk &&
        forcePageFetch &&
        overlayPageUrl &&
        /^https?:\/\//i.test(overlayPageUrl) &&
        !electronPageTextRich
      ) {
        try {
          const fullPage = await fetchWebPage(overlayPageUrl, {
            timeoutMs: 7000,
            maxChars: 12000,
          });
          if (fullPage?.ok && fullPage.content && !fullPage.spa_shell) {
            prompt +=
              `\n\n[FULL_PAGE_FETCH — fetched from their open tab URL; use this for site-wide asks beyond the screenshot. ` +
              `Do NOT ask them to paste the link or scroll.]\n` +
              `URL: ${fullPage.url}\n` +
              (fullPage.title ? `Title: ${fullPage.title}\n` : '') +
              `--- FULL PAGE TEXT ---\n${fullPage.content}\n--- END FULL PAGE ---`;
            console.log(
              `🌐 Stream: Glass full-page fetch OK (${fullPage.char_count || fullPage.content.length} chars) ${overlayPageUrl}`,
            );
          } else if (fullPage?.ok && fullPage.spa_shell) {
            // Meta-only SPA shell — don't pretend it's the whole site.
            console.log(
              `🌐 Stream: Glass full-page fetch SPA shell only (${fullPage.char_count} chars) ${overlayPageUrl}`,
            );
          } else {
            console.log(
              `🌐 Stream: Glass full-page fetch miss (${fullPage?.error || 'empty'}) ${overlayPageUrl}`,
            );
          }
        } catch (e) {
          console.warn('🌐 Stream: Glass full-page fetch error:', e?.message || e);
        }
      } else if (overlayAsk && forcePageFetch && electronPageTextRich) {
        console.log('🌐 Stream: Glass full-page — using Electron scroll scrape (skip HTTP shell fetch)');
      }
      if (vagueBuildAsk) {
        prompt +=
          `\n\n[BUILD_CLARIFY — Build/Create mode is already on, but the user did not name what to build. ` +
          `Do NOT call lykn_build_react_artifact, lykn_build_template, lykn_build_spreadsheet, lykn_render_video, or any other builder this turn. ` +
          `Do NOT invent a mini-game, landing page, dashboard, or any other deliverable. ` +
          `Do NOT tell them to arm or click Build. ` +
          `Ask ONE short question: what should I build? Offer 2–4 concrete options (a playable mini-game, a landing page, a dashboard, a small utility). Wait for their pick.]`;
      } else if (artifactBuildSpec) {
        prompt +=
          `\n\n[BUILD_ARTIFACT — Build/Create mode is ALREADY ARMED for this message; you are building a ${artifactBuildSpec.label} (a claude.ai-style Artifact). ` +
          `Never tell the user to arm/enable/turn on Build mode or Create — it is already on. ` +
          `Never tell the user to close, clear, or dismiss an open artifact panel — just call the tool and build. ` +
          `Do NOT narrate a plan or describe what you would build instead of calling the tool. ` +
          `The user sees live status of each part as you write — pass \`todos\` with short human labels (Hero, Pricing, Footer) and mark the current one in_progress. ` +
          `You MUST call the ${artifactBuildSpec.tool} tool on this turn to produce it` +
          (artifactBuildSpec.templateType ? ` with template_type "${artifactBuildSpec.templateType}"` : '') +
          (artifactBuildSpec.tool === 'lykn_build_spreadsheet' ? ` with output_format "xlsx" (a real downloadable spreadsheet), passing headers + rows` : '') +
          (artifactBuildSpec.tool === 'lykn_build_react_artifact'
            ? `. WRITE the deliverable in React: for simple tools/docs use a single \`code\` component (export default); for games, multi-scene apps, or anything with several systems, use multi-file \`files\` ([{path, content}], entry App.jsx) with relative imports between modules — split game/, components/, lib/. Include a \`todos\` plan on complex builds. Tailwind for layout/typography, React hooks for interactivity, and the in-scope library stack only when needed — Recharts/LucideReact for charts and icons, framer-motion (motion/AnimatePresence) for animation, d3, three.js (THREE) for 3D, lodash (_), dayjs, mathjs (math), Papa, marked, Tone, confetti, html2canvas + jsPDF for export buttons. STYLE IT by following the [DESIGN_SYSTEM] brief below exactly — its color tokens, type scale, spacing, and component recipes — plus the [STYLE_GUIDE] block's structure rules when one is included. MATCH COMPLEXITY: a quick utility = one focused screen; a website/dashboard/presentation = full multi-section treatment; a game/app = multi-file with real loops/states. Never pad a simple request with filler sections`
            : '') +
          (artifactBuildSpec.tool === 'lykn_render_video'
            ? `. WRITE the deliverable as one complete Remotion composition (export default one component; imports ONLY from "remotion" and "react"; every visual property a pure function of useCurrentFrame() via interpolate/spring; inline style objects, system fonts; <Img> from "remotion" for hosted image URLs listed in [USER_IMAGES]/[GENERATED_IMAGES] — never invented URLs; no registerRoot/<Composition>). Keep it SHORT and purposeful (default ~5s, max 30s), end with the motion resolved, and pass duration_in_frames/fps/width/height that fit the request`
            : '') +
          `. Infer the topic and full contents from the user's message and any context above; make it complete, well-structured, and visually clean — don't ask a clarifying question first unless the request is truly unusable. ` +
          `After the tool returns, reply with just a 1-2 sentence summary of what you built; do NOT paste the raw HTML, code, or chart config into the chat (the artifact renders on its own).]`;
      }
      if (activeArtifactDiscussOnly && activeArtifact) {
        const kindHint =
          activeArtifact.toolName === 'lykn_build_react_artifact'
            ? 'coded React app/page'
            : activeArtifact.toolName === 'lykn_build_template'
              ? String(activeArtifact.templateType || 'document')
              : activeArtifact.toolName === 'lykn_build_spreadsheet'
                ? 'spreadsheet'
                : 'artifact';
        prompt +=
          `\n\n[ARTIFACT_VISIBLE — The user has "${String(activeArtifact.title || 'Untitled').slice(0, 200)}" ` +
          `(${kindHint}) open in the preview popup, but builder tools are not armed for this turn. ` +
          `You may discuss, explain, critique, brainstorm about, or answer questions about this artifact using conversation context. ` +
          `Do NOT call lykn_build_react_artifact, lykn_build_template, lykn_build_spreadsheet, lykn_manage_file, or any other build/edit tool, ` +
          `and do NOT modify the open artifact. Answer the user's question directly without claiming you changed anything.]`;
      } else if (activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact') {
        const a = activeArtifact;
        const multiFiles = Array.isArray(a.files) ? a.files.filter((f) => f && typeof f.path === 'string') : [];
        const isMulti = multiFiles.length > 0;
        let sourceBlock = '';
        if (isMulti) {
          const entryName = String(a.entry || 'App.jsx');
          const listing = multiFiles.map((f) => `  - ${f.path} (${String(f.content || '').length} chars)`).join('\n');
          // Cap total source shown — prefer entry + smaller modules first.
          const sorted = [...multiFiles].sort((x, y) => {
            if (x.path === entryName) return -1;
            if (y.path === entryName) return 1;
            return String(x.path).localeCompare(String(y.path));
          });
          let budget = 70000;
          const parts = [];
          for (const f of sorted) {
            const body = String(f.content || '');
            const slice = body.slice(0, Math.min(body.length, Math.max(2000, budget)));
            budget -= slice.length;
            parts.push(`—— ${f.path} ——\n\`\`\`jsx\n${slice}${slice.length < body.length ? '\n/* …truncated… */' : ''}\n\`\`\``);
            if (budget <= 0) {
              parts.push(`(/* ${sorted.length - parts.length} more files omitted — use path-scoped edits / file_ops */)`);
              break;
            }
          }
          sourceBlock =
            `• multi-file project (entry: ${entryName}):\n${listing}\n` +
            `• sources:\n${parts.join('\n')}\n`;
        } else {
          const codeSrc = String(a.code || '').slice(0, 60000);
          sourceBlock = `• current component source (JSX):\n\`\`\`jsx\n${codeSrc}\n\`\`\`\n`;
        }
        const todos = Array.isArray(a.todos) ? a.todos : [];
        const todosBlock = todos.length
          ? `• coding plan (todos):\n${todos.map((t) => `  - [${t.status || 'pending'}] ${t.id || '?'}: ${String(t.content || '').slice(0, 200)}`).join('\n')}\n`
          : '';
        const runtimeErrs = Array.isArray(a.runtimeErrors) ? a.runtimeErrors.slice(0, 12) : [];
        const runtimeBlock = runtimeErrs.length
          ? `• RUNTIME ERRORS from the live preview (FIX THESE with targeted edits before adding features):\n` +
            runtimeErrs.map((e) => `  - ${String(e.message || e).slice(0, 400)}`).join('\n') + '\n'
          : '';
        prompt +=
          `\n\n[ARTIFACT_OPEN — ${appEditTurn
            ? 'The user opened this installed app in Build mode to edit it (there is no preview popup):'
            : 'The user has this coded React artifact open in the preview popup and may ask you to refine it:'}\n` +
          `• title: ${String(a.title || 'Untitled').slice(0, 200)}\n` +
          sourceBlock +
          todosBlock +
          runtimeBlock +
          (appEditTurn
            ? `If the user's message asks to change, fix, add to, or otherwise edit THIS app, you MUST call lykn_build_react_artifact again with the same title (unless they ask to rename it). ` +
              `This is an installed-app edit, not a fresh commission — keep the existing source as the base. ` +
              `REQUIRED: patch in place with \`edits\` ({find, replace}${isMulti ? ', with path' : ''}) and/or \`file_ops\`; preserve every untouched line, component, behavior, and style. ` +
              `Changing a color, font, selected state, spacing value, label, or adding a localized feature is still a patch — never a reason to rewrite the app. ` +
              `Pass full \`files\` or \`code\` with full_rewrite: true ONLY when the user explicitly asks to redesign, rebuild, start over, or replace the app. Style and theme changes are allowed only to the exact extent requested. ` +
              `ONE CALL PER TURN. After it returns, reply with a 1-2 sentence summary of what changed; do NOT paste the code. ` +
              `If the message is NOT about this app, ignore this and answer normally.]`
            : `If the user's message asks to change, fix, add to, shorten, expand, or otherwise refine THIS artifact, you MUST call lykn_build_react_artifact again with the same title (unless they ask to rename it). ` +
              `Build mode does NOT mean rebuild — with this popup open, add/edit/fix requests are ALWAYS in-place patches, never a new artifact from scratch. ` +
              `PRESERVE THE LOOK — keep THEME tokens, Tailwind classes, layout structure, fonts, colors, radii, and overall visual design exactly as they are. Expanding data arrays / hook banks / copy lists is a CONTENT edit, not a redesign. Swapping a color palette or font "while you're at it" is a FAILURE. ` +
              `SCOPE DISCIPLINE — implement EXACTLY the requested change and NOTHING else. Every line the request doesn't touch must survive byte-for-byte — no reformatting, re-indenting, renaming, recoloring, copy rewrites, layout shuffles, comment stripping, or unrequested "improvements". If you notice something else worth fixing, mention it in your reply; do not change it. ` +
              (isMulti
                ? `REQUIRED: call ONCE with \`edits\` ({path, find, replace}) and/or \`file_ops\` ({op:"write"|"delete", path, content?}) covering EVERY change in this message. The server REJECTS full \`files\`/\`code\` unless the user explicitly said redesign/rebuild/start over (then full_rewrite: true). `
                : `REQUIRED: call ONCE with \`edits\` ONLY — an array of {find, replace} patches covering EVERY change in this message. Each \`find\` is an exact, unique snippet copied verbatim from the source above (whitespace included; replace: "" deletes) and each \`replace\` is the MINIMAL rewrite of just those lines. The server REJECTS full \`code\` and ignores full_rewrite unless the user explicitly said redesign/rebuild/start over. `) +
              `Do NOT call this tool multiple times in one turn — batch all patches into that single call, then summarize. ` +
              `If the tool returns compile_error / edits_required / edit_target_not_found, fix and retry silently before telling the user you're done — never leave them with a broken preview. ` +
              `Never change THEME, colors, fonts, or layout on a refine. Update \`todos\` statuses on longer builds. ` +
              `After it returns, reply with a 1-2 sentence summary of what changed; do NOT paste the code. ` +
              `If the message is NOT about the artifact, ignore this and answer normally.]`);
      } else if (activeArtifactEditable && activeArtifact.toolName === 'lykn_build_template') {
        const a = activeArtifact;
        const tType = String(a.templateType || 'document');
        const curTheme = (typeof a.theme === 'string' && a.theme.trim()) ? a.theme.trim() : 'default (clay/orange)';
        const curFont = (typeof a.font === 'string' && a.font.trim()) ? a.font.trim() : 'default';
        let sectionsJson = '[]';
        try {
          const secs = Array.isArray(a.sections) ? a.sections : [];
          sectionsJson = JSON.stringify(secs).slice(0, 14000);
        } catch { sectionsJson = '[]'; }
        const templateRestyleAuthorized = redesignArtifactAsk;
        prompt +=
          `\n\n[ARTIFACT_OPEN — The user has this artifact open in the preview popup and may ask you to refine it:\n` +
          `• title: ${String(a.title || 'Untitled').slice(0, 200)}\n` +
          `• template_type: ${tType}\n` +
          `• current theme: ${curTheme}\n` +
          `• current font: ${curFont}\n` +
          `• current sections (JSON): ${sectionsJson}\n` +
          (templateRestyleAuthorized
            ? `RESTYLE / REFERENCE MATCH AUTHORIZED THIS TURN: the user asked to rebuild or match a new visual style. ` +
              `Call lykn_build_template ONCE with template_type "${tType}", a fitting title, the FULL new \`sections\` array, and full_rewrite: true. ` +
              `Replace the visual system (colors, layout language, typography) to match their reference — do NOT ask them for magic words, and do NOT use section_edits for a whole-theme swap. `
            : `STYLE-ONLY (font / color / theme): If the user ONLY asked to change the font, typeface, accent color, or theme — call lykn_build_template with template_type "${tType}", the SAME title, and ONLY \`font\` and/or \`theme\`. OMIT \`sections\` entirely. The server keeps every slide/section byte-identical. Do NOT rewrite, rephrase, reorder, or "improve" slide copy on a font/color ask. ` +
              `CONTENT EDITS: call lykn_build_template with \`section_edits\` ONLY — {find, replace}, {index|id, heading?/body?/notes?}, {insert_at, section}, or {remove_index|remove_id}. Do NOT resubmit the full \`sections\` array; the server REJECTS undeclared full-section rebuilds. Always pass the current theme/font back unless they asked to change them. ` +
              `Full \`sections\` + full_rewrite: true ONLY when they explicitly asked to rebuild/restyle the whole artifact. `) +
          `Font names: inter, georgia, playfair, space-grotesk, merriweather, mono, system. Theme: a color name (blue, green, purple…) or hex. ` +
          `After it returns, reply with a 1-2 sentence summary of what changed; do NOT paste raw HTML or markup. ` +
          `If the message is NOT about the artifact, ignore this and answer normally.]`;
      } else if (activeArtifactEditable && activeArtifact.toolName === 'lykn_manage_file') {
        const a = activeArtifact;
        const src = String(a.fileContent || '').slice(0, 60000);
        prompt +=
          `\n\n[ARTIFACT_OPEN — The user has this file artifact open and may ask you to refine it:\n` +
          `• title: ${String(a.title || 'Untitled').slice(0, 200)}\n` +
          `• current file source:\n\`\`\`\n${src}\n\`\`\`\n` +
          `If refining THIS file, call lykn_manage_file (action=edit) with \`edits\` ONLY — {find, replace} patches copied verbatim from the source above. Do NOT resubmit full \`content\` unless they explicitly asked to rebuild (then set full_rewrite: true). ` +
          `After it returns, reply with a 1-2 sentence summary; do NOT paste the file. ` +
          `If the message is NOT about the artifact, ignore this and answer normally.]`;
      } else if (activeArtifactEditable && activeArtifact.toolName === 'lykn_build_spreadsheet') {
        const a = activeArtifact;
        let sheetJson = '{}';
        try {
          sheetJson = JSON.stringify({
            headers: Array.isArray(a.headers) ? a.headers : [],
            rows: Array.isArray(a.rows) ? a.rows : [],
          }).slice(0, 14000);
        } catch { sheetJson = '{}'; }
        prompt +=
          `\n\n[ARTIFACT_OPEN — The user has this spreadsheet open and may ask you to refine it:\n` +
          `• title: ${String(a.title || 'Sheet').slice(0, 200)}\n` +
          `• current data (JSON): ${sheetJson}\n` +
          `If refining THIS sheet, call lykn_build_spreadsheet with \`cell_edits\` ONLY — {row, col|column, value}, {row, values}, {insert_row, values}, or {remove_row}. Do NOT resubmit full headers/rows unless they explicitly asked to rebuild (then set full_rewrite: true). ` +
          `After it returns, reply with a 1-2 sentence summary. ` +
          `If the message is NOT about the artifact, ignore this and answer normally.]`;
      }
      if (streamBoundProjectId && req.user?.id && supabaseAdmin) {
        const boundRow = await loadWritableProject(supabaseAdmin, req.user.id, streamBoundProjectId);
        if (boundRow) {
          prompt += '\n\n' + formatBoundProjectGuidance(boundRow);
        }
      }
      // Cursor cloud-agent builds that finished since we last told the user.
      // Surface once in the in-app chat too (same one-shot claim the voice
      // briefing uses), gated to substantive turns to avoid a write per message.
      if (!streamWantsPureGreeting && req.user?.id && supabaseAdmin && isCursorBuildsConfigured()) {
        try {
          const finishedBuilds = await claimUnannouncedBuilds(supabaseAdmin, req.user.id);
          if (finishedBuilds.length) {
            const buildLines = finishedBuilds.map((b) => {
              const outcome = b.status === 'completed' ? 'ready for testing' : `did not finish (${b.status})`;
              const pr = b.pr_url ? ` PR: ${b.pr_url}` : '';
              return `- ${String(b.instruction).slice(0, 200)} (${outcome})${pr}`;
            });
            prompt += '\n\n[CURSOR_BUILDS_FINISHED — mention this near the start of your reply: a Cursor build you started has finished. It is ready for the user to test; deployment is manual. Share the PR link if present; never invent one.]\n' + buildLines.join('\n');
          }
        } catch (e) {
          console.warn('⚠️ stream cursor builds surface:', e?.message || e);
        }
      }
      if (memorySection) prompt += "\n\n" + sanitizeStaleSurfaceLanguage(memorySection);
      if (streamWantsPureGreeting) prompt += "\n\n" + GREETING_TURN_PROMPT;
      else if (streamWantsUserRecallDeepen) prompt += "\n\n" + USER_RECALL_DEEPEN_PROMPT;
      else if (streamWantsUserRecall) prompt += "\n\n" + USER_RECALL_TURN_PROMPT;
      if (streamCustomModelKnowledge) prompt += "\n\n" + sanitizeStaleSurfaceLanguage(streamCustomModelKnowledge);
      if (vaultUrlMatches) prompt += "\n\n" + vaultUrlMatches;
      const webObservation = formatUntrustedWebObservation(scrapedContent, searchResults, youtubeResults);
      const splitPromptForProviderWithWeb = (nextPrompt) =>
        attachUntrustedWebObservation(splitPromptForProvider(nextPrompt), webObservation);
      if (streamCustomModelCtx.overlay) {
        prompt = applyCustomModelOverlayToPrompt(prompt, streamCustomModelCtx.overlay);
      }
      if (streamChatAgentCtx?.instructionsBlock) {
        prompt += `\n\n${streamChatAgentCtx.instructionsBlock}`;
      }
      // Default main agent over published custom models — soft-unplugged.
      if (
        CUSTOM_MODELS_ENABLED &&
        useTools &&
        (!Array.isArray(streamChatToolNames) ||
          streamChatToolNames.includes('lykn_communicate_with_model')) &&
        !streamOrchestrationCtx?.isMainAgent &&
        req.user?.id &&
        supabaseAdmin
      ) {
        try {
          const defaultRoster = await loadPublishedRoster(supabaseAdmin, req.user.id, {
            excludeId: streamCustomModelCtx.customModel?.id || null,
            limit: 16,
          });
          const defaultBlock = formatDefaultMainAgentBlock(defaultRoster);
          if (defaultBlock) {
            streamOrchestrationCtx = { ...(streamOrchestrationCtx || {}), orchestrationBlock: defaultBlock };
          }
        } catch (e) {
          console.warn('[default-main-agent] roster load failed:', e?.message || e);
        }
      }
      if (streamOrchestrationCtx?.orchestrationBlock) {
        prompt += `\n\n${streamOrchestrationCtx.orchestrationBlock}`;
      }

      let actualModel = model;
      if (model === 'unified-auto') {
        if (process.env.GOOGLE_API_KEY) actualModel = 'gemini-flash-latest';
        else if (process.env.OPENAI_API_KEY) actualModel = 'gpt-4.1-nano';
        else actualModel = 'gpt-4.1-nano';
      } else if (LYKN_ROUTED_MODELS[model]) {
        actualModel = resolveLyknAlias(model);
        console.log(`🟣 LYKN alias (${model}) → ${actualModel}`);
      }

      // Image turns on a weak-vision model get bumped to a stronger reader so
      // text inside the image is actually legible (no-op for text-only turns).
      actualModel = upgradeModelForVision(actualModel, imageUrls.length > 0);

      // Coded-artifact turns (forced lykn_build_react_artifact build, or an
      // open React artifact being edited) route to the dedicated coding model
      // (grok-4.5 when the xAI key is set — cheaper frontier coder) and get a
      // bigger per-hop output cap below so a full app/site fits in one call.
      const codedArtifactTurn =
        artifactToolName === 'lykn_build_react_artifact' ||
        (activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact');
      // Video-render turns (lykn_render_video) are model-chosen — sniffed from
      // wording only. Extends the SSE ceiling and image-URL prompt blocks below.
      const videoRenderLikelyTurn =
        artifactToolName === 'lykn_render_video' || VIDEO_RENDER_INTENT_RE.test(String(text || ''));
      actualModel = upgradeModelForCodedArtifact(actualModel, codedArtifactTurn);
      // grok-4.5 reproducibly truncates its stream (no finish_reason, no tool
      // call) whenever an IMAGE rides on a forced-tool request. Images reach a
      // build turn two ways, distinguished via the per-turn `attachments`
      // metadata (user uploads carry an imageIndex; the overlay's automatic
      // screenshot is never listed there):
      //   • user ATTACHED an image (mockup/reference) → the pixels matter, so
      //     switch to a vision-capable frontier coder: Opus 4.8, then GPT-5.6.
      //   • screenshot only, request REFERENCES the screen ("build a chart
      //     from this data", "a site like this one") → the pixels matter just
      //     the same: keep the screenshot and switch to the vision coders.
      //     (The scraped page text also stays in the prompt as backup.)
      //   • screenshot only, request is self-contained ("build me a website
      //     for LYKN") → DROP it and stay on grok. The screenshot is dead
      //     weight that would otherwise force a slower, pricier model on
      //     every overlay build.
      if (codedArtifactTurn && imageUrls.length > 0 && actualModel.includes('grok')) {
        const attachmentsArr = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
        const userAttachedImage = attachmentsArr.some(
          (a) => a && (a.type === 'image' || Number.isInteger(a.imageIndex)),
        );
        const buildReferencesScreen = BUILD_SCREEN_REF_RE.test(String(text || ''));
        // Overlay auto-screenshots are NOT listed in attachments. Chat Build /
        // Create OR a typed "build me a game" + image (auto-inferred / reference
        // rebuild) is almost always a user attach — keep those pixels even if
        // attachment metadata is missing/malformed.
        const chatBuildWithImages =
          (forceArtifact || artifactAutoInferred || buildModeFresh) &&
          imageUrls.length > 0 &&
          req.body?.overlayAsk !== true;
        const imageMatters = userAttachedImage || buildReferencesScreen || chatBuildWithImages;
        const why = userAttachedImage
          ? 'user attached an image'
          : chatBuildWithImages
            ? 'Build mode with attached image(s)'
            : 'request references the screen';
        if (!imageMatters) {
          console.log(`🧑‍💻 Code-artifact: dropping ${imageUrls.length} screen-capture image(s) (self-contained build request) — staying on ${actualModel}`);
          imageUrls = [];
        } else if (process.env.ANTHROPIC_API_KEY) {
          console.log(`🧑‍💻 Code-artifact reroute: ${actualModel} → claude-opus-4-8 (${why} — grok truncates forced-tool streams with images)`);
          actualModel = 'claude-opus-4-8';
        } else if (process.env.OPENAI_API_KEY) {
          console.log(`🧑‍💻 Code-artifact reroute: ${actualModel} → gpt-5.6-sol (${why} — grok truncates forced-tool streams with images)`);
          actualModel = 'gpt-5.6-sol';
        } else if (process.env.GOOGLE_API_KEY) {
          console.log(`🧑‍💻 Code-artifact reroute: ${actualModel} → gemini-3.1-pro-preview (${why} — grok truncates forced-tool streams with images)`);
          actualModel = 'gemini-3.1-pro-preview';
        } else {
          // No vision-capable alternative configured — drop the images so the
          // build at least completes instead of dying in grok retries. The
          // scraped page text still rides in the prompt, so grok gets a
          // textual account of the screen even without the pixels.
          console.warn('🧑‍💻 Code-artifact: no alternate provider for screen-referenced build — dropping images, staying on grok (page text still in prompt)');
          imageUrls = [];
        }
      }

      // Tool-calling agent loop: all four providers (OpenAI / Anthropic /
      // Gemini / Grok) support native function calling via chat-agent-loop.js.
      // We respect whatever model the user picked — no forced downgrade.
      // If the resolved model genuinely doesn't support tools (e.g. some
      // legacy alias), we surface the swap header and route to a safe
      // tool-capable default so the in-app tool surface still works.
      if (useTools && !supportsTools(actualModel)) {
        try { res.setHeader('X-Tool-Route', `${actualModel}->gpt-4.1-nano`); } catch { /* headers already flushed */ }
        console.log(`🔧 Stream tool-route: ${actualModel} → gpt-4.1-nano (useTools, model has no tool support)`);
        actualModel = 'gpt-4.1-nano';
      }
      // Append the in-app tool-calling addendum to the prompt so the model
      // knows WHEN to call. The descriptors themselves go on the provider
      // request as `tools[]` / `functionDeclarations` — that's the schema;
      // this is the policy.
      if (useTools) {
        if (
          mcpTurn?.resolution?.ambiguous
        ) {
          prompt +=
            '\n\n[MCP CONNECTIONS — AMBIGUOUS ACCOUNT]\n' +
            'Multiple equivalent external accounts could perform this write. Ask the user which connection to use. Do not pick one arbitrarily. Candidates: ' +
            (mcpTurn.resolution.candidates || [])
              .map((c) => `${c.connectionName} (${c.connectionId})`)
              .join(', ') +
            '.';
        } else if (mcpTurn?.resolution?.reason === 'missing_capability') {
          const names = (mcpTurn.suggestions || []).map((item) => item.name).filter(Boolean);
          try {
            getMcpManager(supabaseAdmin).noteAttention(req.user.id, {
              type: 'missing_capability',
              title: names[0] ? `Connect ${names[0]}` : 'Connect a service',
              catalogId: mcpTurn.suggestions?.[0]?.catalogId || null,
              needs: mcpTurn.resolution.needs || [],
            });
          } catch {
            /* attention is best effort */
          }
          prompt +=
            '\n\n[MCP CONNECTIONS — NEEDS CONNECTION]\n' +
            'This task needs an external connection the user does not have yet. Tell them which service to connect. Do not invent OAuth URLs. Do not browse or install MCP servers. ' +
            (names.length ? `Suggested services: ${names.join(', ')}.` : '');
        }
        const turnCapabilities = streamDisclosure?.capabilities || [];
        if (streamLeanToolSet) {
          prompt += '\n\n' + buildSlimChatToolGuidance(streamChatToolNames, turnCapabilities);
        } else {
          prompt += '\n\n' + buildChatToolGuidance(streamPureUserMessage || streamSearchText, {
            capabilities: turnCapabilities,
            // Fresh Create / image turns get the full visual + design brief.
            // Open-artifact refine turns must NOT — a new [DESIGN_SYSTEM] is what
            // turns "add 10 hooks" into a whole restyle.
            forceMaking: Boolean(
              allowNewArtifactBuild &&
                !lockOutArtifactBuilds &&
                !brainstormBuildMention &&
                (forceImage || artifactToolName),
            ),
            editingArtifact: Boolean(activeArtifactEditable),
            appEdit: Boolean(appEditTurn),
            lockOutArtifactBuilds,
            regularChatBuildAsk: Boolean(regularChatBuildAsk),
            isMainAgent: Boolean(streamOrchestrationCtx?.isMainAgent),
            // Pins the [STYLE_GUIDE] pick for Create-menu builds that map to a
            // known format (study/document/worksheet); wording decides otherwise.
            artifactType: artifactToolName === 'lykn_build_react_artifact' ? artifactType : null,
            // Color is opt-in: neutrals by default unless the user attached a
            // reference idea (image/screenshot) or asked for color in text.
            hasReferenceImages: Array.isArray(imageUrls) && imageUrls.length > 0,
          });
        }
      }
      // Image mode armed: the model has no other way to know the user flipped
      // the "Generate image" toggle — without this it replies "arm image mode
      // and I'll recreate it" WHILE the mode is on, or narrates a spec instead
      // of generating. tool_choice forces the call regardless; this line makes
      // the accompanying text match reality.
      if (forceImage) {
        prompt +=
          '\n\n[IMAGE_MODE — image generation is ALREADY ARMED for this message; lykn_generate_image WILL run. ' +
          'Never tell the user to arm/enable/turn on image mode, never ask permission, and never describe what an ' +
          'image WOULD look like instead of generating it. Any image(s) the user attached this turn are ' +
          'automatically given to the image model as pixel references — for "recreate this" asks, call the tool ' +
          'with a prompt describing only the desired CHANGES (or "faithful recreation, cleaned up" if none) and ' +
          'trust the reference to carry the likeness. ' +
          'After the image tool runs, reply with a short confirmation only — do NOT search the Vault, ' +
          'do NOT load or dump notes/files from [WHAT_IVE_SAVED] / [WORKSPACE_CONTEXT] / conversation memory, ' +
          'and do NOT pull unrelated saved content.]';
      }
      // Iterative image refinement (see imageFollowUpRefUrl above): hand the
      // previous render's URL to the model so it grounds the new generation in
      // those pixels via reference_image_urls.
      if (forceImage && imageFollowUpRefUrl) {
        prompt +=
          '\n\n[IMAGE_REFERENCE — this request refines an image you generated earlier (its markdown card is in the ' +
          `conversation). When you call lykn_generate_image, pass reference_image_urls: ["${imageFollowUpRefUrl}"] ` +
          'so the image model works from the ACTUAL previous pixels, and write the prompt as the CHANGE relative to ' +
          'it ("same scene at night") — do not re-describe the whole image from scratch. Skip the reference only if ' +
          'the user is clearly asking for a brand-new unrelated image.]';
      }
      // Reference-image builds: when a coded-artifact turn carries images the
      // user actually supplied (attachment metadata, or an overlay screenshot
      // the request explicitly references), two things change:
      //   1. FIDELITY OVERRIDE — the model must build what the reference SHOWS
      //      (its layout, its sampled colors — even purple/gradients — its type
      //      feel), demoting the design system / structure roll to gap-filler.
      //      Appended AFTER the guidance block so it reads as the override.
      //   2. HOSTED EMBEDS — user-attached images are persisted to capability
      //      storage and their proxied URLs handed to the model, so "put my
      //      logo in the header" / "use this photo in the hero" can embed the
      //      real pixels via <img src> instead of a placeholder.
      if ((codedArtifactTurn || videoRenderLikelyTurn) && imageUrls.length > 0) {
        const attachedImageMeta = (Array.isArray(req.body?.attachments) ? req.body.attachments : [])
          .filter((a) => a && (a.type === 'image' || Number.isInteger(a.imageIndex)));
        const referencesScreen = BUILD_SCREEN_REF_RE.test(String(text || ''));
        // Build mode / typed game-from-image: always treat pixels as reference.
        const buildModeVision =
          (forceArtifact || artifactAutoInferred || buildModeFresh) &&
          imageUrls.length > 0 &&
          req.body?.overlayAsk !== true;
        if (codedArtifactTurn && (attachedImageMeta.length > 0 || referencesScreen || buildModeVision)) {
          prompt +=
            `\n\n[ATTACHED_VISION — ${imageUrls.length} image(s) are attached as REAL pixel input on this turn. ` +
            'You CAN see them in this message. Do not claim you cannot view images. Use what they show.]\n' +
            '\n[REFERENCE_BUILD — the user supplied image(s)/screen context as the REFERENCE for this build. ' +
            'FIDELITY OVERRIDES THE DESIGN SYSTEM: recreate what the reference shows. ' +
            'WORK IN TWO PASSES. PASS 1 — TRANSCRIBE (do this mentally before writing any code): inventory the ' +
            'reference top-to-bottom — (a) every section/region in order and its internal layout (columns, grids, ' +
            'alignment); (b) ALL visible text VERBATIM (headlines, labels, buttons, nav items, numbers — copy the ' +
            'exact words, do not paraphrase or invent replacements); (c) concrete colors as hex approximations ' +
            'sampled from the image (background, surfaces, text, accents — purple and gradients ARE allowed here ' +
            'when the reference uses them); (d) typography (relative sizes, weights, casing) and (e) shape language ' +
            '(corner radii, borders, shadows, spacing density, icon style). PASS 2 — REBUILD that inventory 1:1 in ' +
            'Tailwind, with exact arbitrary values (e.g. bg-[#1a2b3c], rounded-[14px]) instead of the nearest ' +
            'default token when the reference clearly differs. Match element COUNTS (4 cards means exactly 4 ' +
            'cards) and positions; when a detail is genuinely illegible, choose the most plausible value consistent ' +
            'with the rest — never substitute your own taste for a visible detail. The [DESIGN_SYSTEM], ' +
            '[STYLE_GUIDE], and STRUCTURE ROLL apply ONLY to details the reference does not show; the never-do ' +
            'list yields wherever it conflicts with a faithful recreation. If the user asked for changes relative ' +
            'to the reference ("like this but dark"), transcribe first, then apply exactly those changes.]';
        }
        if ((attachedImageMeta.length > 0 || buildModeVision) && supabaseAdmin && req.user?.id) {
          const hosted = [];
          const seenHosted = new Set();
          const pushHosted = (name, url) => {
            const u = String(url || '').trim();
            if (!u || seenHosted.has(u)) return;
            seenHosted.add(u);
            hosted.push({ name: name || `image ${hosted.length + 1}`, url: u });
          };
          const sources = attachedImageMeta.length
            ? attachedImageMeta.slice(0, 4)
            : imageUrls.slice(0, 4).map((url, i) => ({ name: `image ${i + 1}`, imageIndex: i, url }));
          for (const a of sources) {
            const dataUrl = Number.isInteger(a.imageIndex) ? imageUrls[a.imageIndex] : a.url;
            const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(dataUrl || ''));
            if (m) {
              try {
                const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg').split('+')[0];
                const stored = await persistCapabilityArtifact(supabaseAdmin, req.user.id, {
                  buffer: Buffer.from(m[2], 'base64'),
                  filename: `${String(a.name || 'image').replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || 'image'}.${ext}`,
                  mimeType: m[1],
                  category: 'user-images',
                });
                if (stored.ok) pushHosted(a.name, stored.file_url);
              } catch (err) {
                console.warn('🧑‍💻 Code-artifact: failed to host user image for embedding:', err?.message);
              }
            } else if (/^https?:\/\//i.test(String(dataUrl || ''))) {
              // Already a hosted/signed URL — pass through for <img> embeds.
              pushHosted(a.name, dataUrl);
            } else if (/^https?:\/\//i.test(String(a.url || ''))) {
              pushHosted(a.name, a.url);
            }
          }
          if (hosted.length > 0) {
            prompt +=
              '\n\n[USER_IMAGES — the user\'s attached image(s) are hosted and embeddable in builds:\n' +
              hosted.map((h, i) => `  ${i + 1}. ${h.name} → ${h.url}`).join('\n') +
              '\nWhen the user wants their image IN the build (their photo, logo, product shot, artwork), embed these ' +
              'exact URLs — <img src> / CSS background-image in a React artifact, or <Img src> from "remotion" in a ' +
              'lykn_render_video composition. When the image is purely a design reference to recreate, follow ' +
              '[REFERENCE_BUILD] and only embed it if they asked.]';
            console.log(`🧑‍💻 Code-artifact: hosted ${hosted.length} user image(s) for in-artifact embedding`);
          }
        }
      }
      // Images LYKN GENERATED earlier in this chat are build material too:
      // "animate that logo", "build a hero section around the image you just
      // made". They live in assistant replies as markdown image lines (the
      // lykn-artifact: prefix marks React previews, which are not images);
      // collect the recent ones and hand their hosted URLs to the build.
      if ((codedArtifactTurn || videoRenderLikelyTurn) && Array.isArray(conversation)) {
        const genSeen = new Set();
        const genImages = [];
        for (let i = conversation.length - 1; i >= 0 && genImages.length < 4; i--) {
          const m = conversation[i];
          const role = m && typeof m === 'object' ? String(m.role || '') : '';
          if (role !== 'assistant' && role !== 'model') continue;
          const found = [...String(m.content || '').matchAll(/!\[(?!lykn[-_]artifact:)[^\]]*\]\((https?:\/\/[^\s)]+)\)/gi)];
          for (let j = found.length - 1; j >= 0 && genImages.length < 4; j--) {
            const url = found[j][1];
            if (!genSeen.has(url)) {
              genSeen.add(url);
              genImages.push(url);
            }
          }
        }
        if (genImages.length > 0) {
          prompt +=
            '\n\n[GENERATED_IMAGES — image(s) generated earlier in this conversation, hosted and embeddable in the ' +
            'artifact (most recent first):\n' +
            genImages.map((u, i) => `  ${i + 1}. ${u}`).join('\n') +
            '\nWhen the request builds on one of these ("animate it", "make a landing page with that image", "turn ' +
            'it into a game sprite", "make it an mp4"), embed the exact URL — <img src> / CSS background-image ' +
            'animated with framer-motion or CSS keyframes in a React artifact, or <Img src> from "remotion" in a ' +
            'lykn_render_video composition when the user wants a real video file. Use the most recent one when the ' +
            'user says "that image" without specifying.]';
          console.log(`🧑‍💻 Code-artifact: offering ${genImages.length} generated image(s) from this chat for embedding`);
        }
      }
      // Always anchor the model to the user's LOCAL current time + timezone so
      // scheduling tools (createEvent/createReminder) resolve clock times to the
      // right instant. req.body.timezone is the browser IANA tz from the client.
      prompt += '\n\n' + localTimeContextLine(req.body?.timezone);

      const hasTranscript = prompt.includes('[VIDEO TRANSCRIPT') || prompt.includes('Full transcript:');
      console.log(`📡 Stream request — model: ${actualModel}, prompt: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)${hasTranscript ? ' [HAS VIDEO TRANSCRIPT]' : ''}${imageUrls.length ? `, images: ${imageUrls.length}` : ''}${skipWebSearch ? ' [skipWebSearch]' : ''}`);

      // Headers already flushed early at the top of the route — proceed
      // straight into the streaming infrastructure setup.
      let streamActivity = Date.now();
      let lastClientWriteAt = Date.now();
      let stallCheck, hardKill, heartbeat;
      let streamedTextLength = 0;
      const streamChatId = req.body?.chatId || null;
      // Set per agent-loop attempt below. Called on every terminal path
      // (sendDone / sendError / client disconnect) so a dead stream also
      // cancels the in-flight provider request instead of silently burning
      // tokens for minutes against a socket nobody is reading.
      let abortCurrentAgentAttempt = null;
      // Local Mode per-turn stream id (assigned below once we know the turn
      // uses tools + Local Mode). Declared here so cleanup can release it.
      let localToolStreamId = null;
      const cleanup = () => {
        clearInterval(stallCheck); clearInterval(heartbeat); clearTimeout(hardKill);
        try { abortCurrentAgentAttempt?.(); } catch { /* already settled */ }
        try { if (localToolStreamId) releaseLocalToolStream(localToolStreamId); } catch { /* noop */ }
      };
      const _streamTextStripper = makeToolSyntaxStripper((text) => {
        if (!res.writableEnded) {
          streamActivity = Date.now();
          lastClientWriteAt = Date.now();
          streamedTextLength += (text || '').length;
          res.write(`data: ${JSON.stringify({ t: text })}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        }
      });
      const sendChunk = (text) => _streamTextStripper.ingest(text);
      // Tool-call SSE event. Mirrors sendChunk's contract (resets the stall
      // watchdog, flushes the response) but ships a structured payload so
      // the client can render an inline pill for each tool the agent loop
      // fires. Status moves running → done | error.
      const sendToolCall = (evt) => {
        if (!res.writableEnded) {
          streamActivity = Date.now();
          lastClientWriteAt = Date.now();
          res.write(`data: ${JSON.stringify({ tool_call: evt })}\n\n`);
          if (typeof res.flush === 'function') res.flush();
        }
        if (
          evt?.status === 'done'
          && PROJECT_WRITE_TOOLS.has(evt.name)
          && evt.result
          && evt.result.ok !== false
          && req.user?.id
        ) {
          invalidateProjectSectionCache(req.user.id);
        }
      };
      const sendStatus = (status) => {
        if (!res.writableEnded) {
          // A status update ("Running tools…") is a genuine sign of life —
          // refresh the stall watchdog so the gap between a tool's args
          // finishing and its result landing doesn't trip the 90s timeout.
          streamActivity = Date.now();
          try { res.write(`data: ${JSON.stringify({ status })}\n\n`); } catch { /* socket closed */ }
          if (typeof res.flush === 'function') res.flush();
        }
      };
      // Upstream-activity ping for the agent loop. Receiving ANY bytes from
      // the provider (text deltas, tool-call argument tokens, etc.) means the
      // stream is healthy even when we have nothing user-visible to forward
      // yet — e.g. the model is streaming a large tool-call argument like the
      // HTML for an "interactive page". Without this the 90s stallCheck below
      // would abort a perfectly live stream mid-build and the user would see
      // the generic "trouble connecting" error after a long wait.
      const noteStreamActivity = () => { streamActivity = Date.now(); };
      const sendDone = () => {
        if (!res.writableEnded) {
          _streamTextStripper.flush();
          cleanup();
          console.log('✅ Stream complete');
          try {
            res.write(`data: ${JSON.stringify({ served_model: actualModel })}\n\n`);
          } catch { /* socket closed */ }
          res.write('data: [DONE]\n\n');
          res.end();
          // Fire-and-forget usage logging for stream
          const streamActionType = classifyActionType('invoke', {
            promptLength: prompt?.length || 0,
            responseLength: streamedTextLength,
            hasImages: imageUrls.length > 0,
            intent,
          });
          getOrCreateSession(req.user?.id, streamChatId).then((session) => {
            logAiUsage({
              sessionId: session?.id,
              userId: req.user?.id,
              actionType: streamActionType,
              model: actualModel,
              provider: detectProvider(actualModel),
              inputTokens: estimateTokens(prompt),
              outputTokens: Math.ceil(streamedTextLength / 4),
            });
          }).catch(() => {});
          const reportIds = streamOrchestrationCtx?.completedReports?.map((t) => t.id) || [];
          if (reportIds.length && req.user?.id && supabaseAdmin) {
            markSubModelTasksNotified(supabaseAdmin, req.user.id, reportIds).catch((e) => {
              console.warn('[orchestration] mark notified failed:', e?.message || e);
            });
          }
        }
      };
      const sendError = (msg) => { if (!res.writableEnded) { cleanup(); console.error('❌ Stream error:', msg); res.write(`data: ${JSON.stringify({ error: msg })}\n\n`); res.end(); } };
      // Stall watchdog uses 90s instead of the old 60s. Gemini Pro thinking
      // pauses can legitimately exceed 60s on dense prompts (long workspace
      // context + synthesis retrieval + web search). The heartbeat below
      // keeps the socket warm; this only catches truly wedged providers.
      //
      // Long-running tool turns (artifacts, video, image gen) go quiet while
      // the provider works — 90s was killing healthy GPT Image / Remotion /
      // grok builds mid-flight. Give them 240s; the 10min hardKill still bounds
      // the whole turn. Tool-batch keepalives also ping streamActivity.
      // Deep research: evidence + long report write can pause between tokens
      // (and OpenAI's 16k clamp often needs a continue hop). Treat like builds
      // so the 90s stall watchdog doesn't kill a healthy mid-report stream.
      const longToolTurn = codedArtifactTurn || videoRenderLikelyTurn || forceImage || deepResearch;
      const streamStallMs = longToolTurn ? 240000 : 90000;
      stallCheck = setInterval(() => {
        if (Date.now() - streamActivity > streamStallMs) {
          console.error(`⏰ Stream stalled — no data for ${Math.round(streamStallMs / 1000)}s+, aborting`);
          sendError(forceImage ? IMAGE_GEN_FAILURE_TEXT : AI_TEMPORARY_FAILURE_TEXT);
        }
      }, 5000);
      // Heartbeat. SSE comments (`: keepalive\n\n`) keep proxies and
      // browser networks from killing the idle TCP connection while
      // Gemini is "thinking" before the first token. Pure no-op on the
      // client (TextDecoder won't surface comment lines as data events).
      heartbeat = setInterval(() => {
        if (res.writableEnded) return;
        if (Date.now() - lastClientWriteAt < 10000) return;
        try {
          res.write(`: keepalive ${Date.now()}\n\n`);
          if (typeof res.flush === 'function') res.flush();
          lastClientWriteAt = Date.now();
        } catch { /* socket closed */ }
      }, 15000);
      // Coded-artifact turns get 10min instead of 5: the model streams the
      // whole React component as tool-call arguments (tens of KB of tokens),
      // and an edit turn re-streams it — a legitimate build can brush 5min.
      // Video-render turns get the same ceiling: composition streaming plus a
      // server-side Remotion render (bundle + headless-Chrome frames + encode)
      // can legitimately take several real minutes.
      const hardKillMs = longToolTurn ? 600000 : 300000;
      hardKill = setTimeout(() => {
        if (!res.writableEnded) {
          console.error(`⏰ Hard timeout — SSE connection open > ${Math.round(hardKillMs / 60000)}min, killing`);
          sendError(forceImage ? IMAGE_GEN_FAILURE_TEXT : AI_TEMPORARY_FAILURE_TEXT);
        }
      }, hardKillMs);
      res.on('close', cleanup);

      // Hard ceiling per provider attempt. The fetch() Promise resolves the
      // moment response headers arrive, after which `ab.clear()` cancels this
      // timer — so in practice this is the *connect/headers* timeout, not the
      // body-streaming timeout (which is enforced separately by `stallCheck`).
      //
      // Why 12s and not 120s: a hung fetch (e.g. Gemini's `*-latest` alias
      // routing to a backend that silently never responds) used to burn the
      // full 120s before failing over to the next model in `_streamModels`,
      // and the global 90s stallCheck would abort the whole stream first.
      // Net result: user saw a "the AI hit a snag" message after 90s with
      // ZERO failover attempts. 12s gives Google's slowest legitimate cold-
      // start a comfortable window while still leaving budget for two more
      // providers in the chain (Gemini Pro → GPT-nano → Claude Haiku) before
      // the 90s stall watchdog trips.
      const PROVIDER_TIMEOUT_MS = 12000;
      const makeProviderAbort = () => {
        const ac = new AbortController();
        const timer = setTimeout(() => { console.error(`⏰ Provider connect timeout after ${PROVIDER_TIMEOUT_MS}ms — falling back to next model`); ac.abort(); }, PROVIDER_TIMEOUT_MS);
        return { signal: ac.signal, clear: () => clearTimeout(timer) };
      };

      // ── Provider fallback: retry with another provider on rate-limit / overload / empty stream ──
      // Two failure modes are now retried automatically:
      //   1. Synchronous fetch failure / non-2xx (rate limit, overload, network) — same as before.
      //   2. Stream connects cleanly but emits ZERO visible text tokens. This is the
      //      Gemini "thought-only" failure mode (model burns its whole token budget on
      //      thought:true parts and finishes with finishReason=STOP / MAX_TOKENS without
      //      ever emitting a content part). The old for-loop only caught case 1, so the
      //      client got a clean [DONE] with no text and surfaced the "Hmm — that one came
      //      back empty" fallback. We now treat both cases identically and walk the
      //      _streamModels chain end-to-end before giving up.
      const _streamModels = buildProviderModelChain(
        actualModel,
        streamCustomModelCtx.overlay,
        getFallbackModels,
      );
      let streamTogetherLoraMessages = null;
      if (streamCustomModelCtx.overlay?.useTogetherMultiTurn) {
        const { system: tSys, user: tUser } = splitPromptForProviderWithWeb(prompt);
        streamTogetherLoraMessages = buildTogetherLoraMessages({
          system: tSys,
          conversation,
          latestUserText: streamUserText,
          supplementalContext: extractSupplementalUserContext(tUser, streamUserText),
          includeTurnRules: false,
        });
        console.log(
          `🧱 Together LoRA multi-turn: ${streamTogetherLoraMessages.length} message(s) (history from conversation[])`,
        );
      }
      const retryNextOrFinalize = (_si, provider, hadText, finalErr) => {
        if (hadText) return sendDone();
        if (_si + 1 < _streamModels.length) {
          console.warn(`⚠️ ${provider} stream produced no visible text (model=${_streamModels[_si]}); retrying with ${_streamModels[_si + 1]}`);
          return tryStreamAt(_si + 1);
        }
        return sendError(AI_TEMPORARY_FAILURE_TEXT);
      };
      const tryStreamAt = async (_si) => {
        if (_si >= _streamModels.length) {
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        if (_si > 0) { actualModel = _streamModels[_si]; console.log(`🔄 Stream fallback → ${actualModel} (attempt ${_si + 1}/${_streamModels.length})`); }

      if (isTogetherModel(actualModel)) {
        if (!process.env.TOGETHER_API_KEY) {
          if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        const ab = makeProviderAbort();
        let togetherRes;
        try {
          const { system: tSys, user: tUser } = splitPromptForProviderWithWeb(prompt);
          const tMessages = streamTogetherLoraMessages?.length
            ? streamTogetherLoraMessages
            : (() => {
                const m = [];
                if (tSys) m.push({ role: 'system', content: tSys });
                m.push({ role: 'user', content: tUser });
                return m;
              })();
          const _strmTCap = clampForProvider(pickOutputCap({ hasImages: imageUrls.length > 0 }), actualModel);
          const attachLora =
            streamCustomModelCtx.overlay?.loraActive &&
            (streamCustomModelCtx.overlay?.loraServerlessHostCandidates || []).includes(actualModel);
          togetherRes = await fetch('https://api.together.ai/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(
              buildTogetherChatBody({
                model: actualModel,
                messages: tMessages,
                max_tokens: _strmTCap,
                stream: true,
                overlay: streamCustomModelCtx.overlay,
                chatParams: attachLora ? streamCustomModelCtx.overlay?.togetherChatParams : undefined,
              }),
            ),
            signal: ab.signal,
          });
          ab.clear();
        } catch (e) {
          ab.clear();
          console.error('❌ Together stream fetch failed:', e.message);
          if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        if (!togetherRes.ok) {
          const err = await togetherRes.json().catch(() => ({}));
          const errMsg = err?.error?.message || togetherRes.statusText;
          console.error('❌ Together API error:', errMsg);
          const togetherModelRetryable = streamCustomModelCtx.overlay?.loraActive
            ? isTogetherLoraInferenceRetryableError(errMsg)
            : isTogetherDedicatedEndpointError(errMsg);
          const canRetry =
            (RETRYABLE_STATUSES.has(togetherRes.status) || togetherModelRetryable) &&
            _si + 1 < _streamModels.length;
          if (canRetry) {
            if (togetherModelRetryable && streamCustomModelCtx.overlay?.loraActive) {
              const nextModel = _streamModels[_si + 1];
              const candidates = streamCustomModelCtx.overlay.loraInferenceCandidates || [];
              const stillLoraHost = candidates.includes(_streamModels[_si + 1]);
              console.warn(
                `⚠️ Together serverless LoRA unavailable (host=${_streamModels[_si]}, adapter=${streamCustomModelCtx.overlay?.loraAdapterId});` +
                  (stillLoraHost ? ' trying next host…' : ` falling back to ${nextModel}`),
              );
              if (!stillLoraHost) {
                try { res.setHeader('X-Lora-Fallback', 'persona-only-base'); } catch { /* headers flushed */ }
                if (_si < candidates.length) {
                  sendStatus('Trying another Together serverless host for your LoRA adapter…');
                } else {
                  sendStatus(
                    `LoRA weights unavailable — replying with ${nextModel?.split('/').pop() || 'base model'} and your custom persona (no fine-tuned weights this turn).`,
                  );
                }
              }
            } else if (togetherModelRetryable) {
              console.warn(`⚠️ Together model unavailable (${_streamModels[_si]}); falling back to ${_streamModels[_si + 1]}`);
            }
            return tryStreamAt(_si + 1);
          }
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        streamActivity = Date.now();
        if (streamCustomModelCtx.overlay?.loraActive) {
          try { res.setHeader('X-Lora-Mode', 'serverless'); } catch { /* headers flushed */ }
        }
        console.log('✅ Together LoRA stream connected, reading tokens...');
        const reader = togetherRes.body;
        let buffer = '';
        let receivedAnyText = false;
        const processTogPayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) { receivedAnyText = true; sendChunk(delta); }
          } catch { /* ignore */ }
        };
        reader.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') return sendDone();
            processTogPayload(payload);
          }
        });
        reader.on('end', () => {
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const payload = trimmed.slice(6);
              if (payload === '[DONE]') return sendDone();
              processTogPayload(payload);
            }
            buffer = '';
          }
          return retryNextOrFinalize(_si, 'Together', receivedAnyText, null);
        });
        reader.on('error', (err) => {
          console.error('❌ Together stream reader error:', err?.message || err);
          return retryNextOrFinalize(_si, 'Together', receivedAnyText, AI_TEMPORARY_FAILURE_TEXT);
        });
        return;

      } else if (isOpenAIModel(actualModel)) {
        if (!process.env.OPENAI_API_KEY) { if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1); return sendError(AI_TEMPORARY_FAILURE_TEXT); }
        const ab = makeProviderAbort();
        let openaiRes;
        try {
          const { system: oaiSys, user: oaiUser } = splitPromptForProviderWithWeb(prompt);
          const oaiMessages = [];
          if (oaiSys) oaiMessages.push({ role: 'system', content: oaiSys });
          const userContent = imageUrls.length > 0
            ? [{ type: 'text', text: oaiUser }, ...imageUrls.map(u => ({ type: 'image_url', image_url: { url: u } }))]
            : oaiUser;
          oaiMessages.push({ role: 'user', content: userContent });
          const _strmOaiCap = clampForProvider(pickOutputCap({
            hasImages: imageUrls.length > 0,
            deepResearch,
            // No intent: pre-generation classifyActionType always returns
            // 'chat_short' (2500 cap), which was the actual cause of MAX_TOKENS
            // hitting on long replies. Falling through to OUTPUT_CAPS.chat
            // gives the model real room to finish its thought.
          }), actualModel);
          const _strmOaiCacheKey = `lykn-${(req.user?.id || 'anon').slice(0, 32)}`;
          openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: actualModel,
              messages: oaiMessages,
              max_completion_tokens: _strmOaiCap,
              prompt_cache_key: _strmOaiCacheKey,
              // gpt-5.6 defaults to reasoning that delays TTFT; agent-loop
              // already sets none — match that on the plain stream path.
              ...( /^gpt-5\.6/.test(String(actualModel)) ? { reasoning_effort: 'none' } : {}),
              stream: true,
            }),
            signal: ab.signal,
          });
          ab.clear();
        } catch (e) {
          ab.clear();
          console.error('❌ OpenAI stream fetch failed:', e.message);
          if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        if (!openaiRes.ok) {
          const err = await openaiRes.json().catch(() => ({}));
          console.error('❌ OpenAI API error:', err?.error?.message || openaiRes.statusText);
          if (RETRYABLE_STATUSES.has(openaiRes.status) && _si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        streamActivity = Date.now();
        console.log('✅ OpenAI stream connected, reading tokens...');
        const reader = openaiRes.body;
        let buffer = '';
        let receivedAnyText = false;
        const processOaiPayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) { receivedAnyText = true; sendChunk(delta); }
          } catch {}
        };
        reader.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') return sendDone();
            processOaiPayload(payload);
          }
        });
        reader.on('end', () => {
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const payload = trimmed.slice(6);
              if (payload === '[DONE]') return sendDone();
              processOaiPayload(payload);
            }
            buffer = '';
          }
          return retryNextOrFinalize(_si, 'OpenAI', receivedAnyText, null);
        });
        reader.on('error', (err) => {
          console.error('❌ OpenAI stream reader error:', err?.message || err);
          return retryNextOrFinalize(_si, 'OpenAI', receivedAnyText, AI_TEMPORARY_FAILURE_TEXT);
        });
        return; // stream connected, exit handler

      } else if (actualModel.includes('claude')) {
        if (!process.env.ANTHROPIC_API_KEY) { if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1); return sendError(AI_TEMPORARY_FAILURE_TEXT); }
        const anthropicModel = resolveAnthropicModel(actualModel);
        const ab = makeProviderAbort();
        let anthropicRes;
        try {
          const { system: strmClaudeSys, user: strmClaudeUser } = splitPromptForProviderWithWeb(prompt);
          let claudeContent = strmClaudeUser;
          if (imageUrls.length > 0) {
            const parts = [{ type: 'text', text: strmClaudeUser }];
            for (const url of imageUrls) {
              if (url.startsWith('data:image/')) {
                const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
                if (match) parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
              } else {
                parts.push({ type: 'image', source: { type: 'url', url } });
              }
            }
            claudeContent = parts;
          }
          const _strmClaudeCap = clampForProvider(pickOutputCap({
            hasImages: imageUrls.length > 0,
            deepResearch,
            // No intent: pre-generation classifyActionType always returns
            // 'chat_short' (2500 cap), which was the actual cause of MAX_TOKENS
            // hitting on long replies. Falling through to OUTPUT_CAPS.chat
            // gives the model real room to finish its thought.
          }), anthropicModel);
          const strmClaudeBody = {
            model: anthropicModel,
            messages: [{ role: 'user', content: claudeContent }],
            max_tokens: _strmClaudeCap,
            stream: true,
          };
          if (strmClaudeSys) {
            strmClaudeBody.system = [{ type: 'text', text: strmClaudeSys, cache_control: { type: 'ephemeral' } }];
          }
          anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': 'prompt-caching-2024-07-31',
              'content-type': 'application/json',
            },
            body: JSON.stringify(strmClaudeBody),
            signal: ab.signal,
          });
          ab.clear();
        } catch (e) {
          ab.clear();
          console.error('❌ Anthropic stream fetch failed:', e.message);
          if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        if (!anthropicRes.ok) {
          const err = await anthropicRes.json().catch(() => ({}));
          console.error('❌ Anthropic API error:', err?.error?.message || anthropicRes.statusText);
          if (RETRYABLE_STATUSES.has(anthropicRes.status) && _si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        streamActivity = Date.now();
        console.log('✅ Anthropic stream connected, reading tokens...');
        const reader = anthropicRes.body;
        let buffer = '';
        let receivedAnyText = false;
        const processClaudePayload = (payload) => {
          try {
            const parsed = JSON.parse(payload);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              receivedAnyText = true;
              sendChunk(parsed.delta.text);
            }
            if (parsed.type === 'message_stop') sendDone();
          } catch {}
        };
        reader.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            processClaudePayload(trimmed.slice(6));
          }
        });
        reader.on('end', () => {
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              processClaudePayload(trimmed.slice(6));
            }
            buffer = '';
          }
          return retryNextOrFinalize(_si, 'Anthropic', receivedAnyText, null);
        });
        reader.on('error', (err) => {
          console.error('❌ Anthropic stream reader error:', err?.message || err);
          return retryNextOrFinalize(_si, 'Anthropic', receivedAnyText, AI_TEMPORARY_FAILURE_TEXT);
        });
        return; // stream connected, exit handler

      } else if (actualModel.startsWith('gemini-') || actualModel.includes('gemini')) {
        if (!process.env.GOOGLE_API_KEY) { if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1); return sendError(AI_TEMPORARY_FAILURE_TEXT); }
        let geminiModel = actualModel;
        if (actualModel === 'gemini-pro' || actualModel === 'gemini-1.5-flash') geminiModel = 'gemini-flash-latest';
        else if (actualModel === 'gemini-1.5-pro') geminiModel = 'gemini-pro-latest';
        else if (actualModel === 'gemini-3-pro-preview') geminiModel = 'gemini-3.1-pro-preview';

        const ab = makeProviderAbort();
        let geminiRes;
        // Hoisted above the try: the MAX_TOKENS handling further down logs the
        // cap, and a `const` inside the try block would be out of scope there.
        let _strmGemCap = 0;
        try {
          const { system: strmGemSys, user: strmGemUser } = splitPromptForProviderWithWeb(prompt);
          const geminiParts = [{ text: strmGemUser }];
          for (const url of imageUrls) {
            try {
              if (url.startsWith('data:image/')) {
                const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
                if (match) geminiParts.push({ inline_data: { mime_type: match[1], data: match[2] } });
              } else {
                const imgRes = await safeFetch(url);
                if (imgRes.ok) {
                  const buf = Buffer.from(await imgRes.arrayBuffer());
                  const mime = imgRes.headers.get('content-type') || 'image/png';
                  geminiParts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
                }
              }
            } catch (imgErr) { console.warn('⚠️ Stream: failed to fetch image for Gemini:', imgErr.message); }
          }
          _strmGemCap = clampForProvider(pickOutputCap({
            hasImages: imageUrls.length > 0,
            deepResearch,
            // No intent: pre-generation classifyActionType always returns
            // 'chat_short' (2500 cap), which was the actual cause of MAX_TOKENS
            // hitting on long replies. Falling through to OUTPUT_CAPS.chat
            // gives the model real room to finish its thought.
          }), geminiModel);
          const strmGemBody = {
            contents: [{ parts: geminiParts }],
            generationConfig: { maxOutputTokens: _strmGemCap, temperature: 0.7 },
          };
          if (strmGemSys) {
            _ck('before getOrCreateGeminiCache');
            const _strmGemCache = await getOrCreateGeminiCache(strmGemSys, geminiModel);
            _ck(`after getOrCreateGeminiCache (cached=${Boolean(_strmGemCache)})`);
            if (_strmGemCache) {
              strmGemBody.cachedContent = _strmGemCache;
            } else {
              strmGemBody.systemInstruction = { parts: [{ text: strmGemSys }] };
            }
          }
          _ck('before fetch streamGenerateContent');
          geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(strmGemBody),
              signal: ab.signal,
            }
          );
          _ck(`after fetch streamGenerateContent (status=${geminiRes.status})`);
          ab.clear();
        } catch (e) {
          ab.clear();
          console.error('❌ Gemini stream fetch failed:', e.message);
          if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        if (!geminiRes.ok) {
          const err = await geminiRes.json().catch(() => ({}));
          console.error('❌ Gemini API error:', err?.error?.message || geminiRes.statusText);
          if (RETRYABLE_STATUSES.has(geminiRes.status) && _si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        streamActivity = Date.now();
        console.log('✅ Gemini stream connected, reading tokens...');
        const reader = geminiRes.body;
        let buffer = '';
        let lastFinishReason = '';
        let blockReason = '';
        let receivedAnyText = false;

        // Pull every text part out of a Gemini SSE payload, skipping the
        // thought-summary parts (Gemini 2.5+ "thinking" mode marks them with
        // `thought: true`). Returns "" when the candidate is purely thought
        // tokens or has no text parts at all.
        const extractGeminiText = (parsed) => {
          const cand = parsed?.candidates?.[0];
          if (!cand) return '';
          const parts = cand?.content?.parts;
          if (!Array.isArray(parts)) return '';
          let out = '';
          for (const part of parts) {
            if (part?.thought === true) continue;
            if (typeof part?.text === 'string') out += part.text;
          }
          return out;
        };

        const processGeminiPayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          let parsed;
          try { parsed = JSON.parse(payload); } catch { return; }
          if (parsed?.error) {
            // In-band error event — Gemini sometimes emits one when a
            // safety/quota issue trips mid-stream. Capture and let the end
            // handler surface a clean message.
            blockReason = parsed.error?.message || blockReason || 'gemini_error';
            return;
          }
          if (parsed?.promptFeedback?.blockReason) {
            blockReason = parsed.promptFeedback.blockReason;
          }
          const text = extractGeminiText(parsed);
          if (text) { receivedAnyText = true; sendChunk(text); }
          const fr = parsed?.candidates?.[0]?.finishReason;
          if (fr) lastFinishReason = fr;
        };

        let _firstChunkLogged = false;
        reader.on('data', (chunk) => {
          if (!_firstChunkLogged) { _firstChunkLogged = true; _ck('first chunk from Gemini reader'); }
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) continue;
            processGeminiPayload(trimmed.slice(6));
          }
        });
        reader.on('end', () => {
          // Drain any trailing content in the buffer. Gemini occasionally
          // closes the connection without a final newline after the last
          // `data: {...}` event, which used to silently drop the final
          // sentence(s) of a reply.
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data: ')) continue;
              processGeminiPayload(trimmed.slice(6));
            }
            buffer = '';
          }
          if (lastFinishReason && lastFinishReason !== 'STOP' && lastFinishReason !== 'MODEL_LENGTH') {
            if (lastFinishReason === 'MAX_TOKENS') {
              // Two distinct sub-cases:
              //   A. We DID receive visible text and just hit the cap on a long
              //      essay reply. Same behaviour as before — log + sendDone, the
              //      client softens any dangling tail with finalizeVisibleReply.
              //   B. We received ZERO visible text. This is the "thought-only burn"
              //      pathology of Gemini 2.5/3 thinking models — the entire token
              //      budget went to thought:true parts and the model never started
              //      the actual reply. Drop into retryNextOrFinalize so the next
              //      model in _streamModels gets a clean shot before the user sees
              //      an empty bubble. (Without this, the client sees a clean [DONE]
              //      with no tokens and surfaces the "Hmm — that one came back
              //      empty" fallback even though we have fallback models queued.)
              if (receivedAnyText) {
                console.warn(`⚠️ Stream hit MAX_TOKENS (model=${actualModel}, cap=${_strmGemCap}). Reply was an essay (~${Math.round(_strmGemCap * 0.75)} words). Consider raising cap if this recurs frequently.`);
              } else {
                console.warn(`⚠️ Gemini MAX_TOKENS with 0 visible tokens (model=${actualModel}, cap=${_strmGemCap}) — likely a thought-only burn. Falling through to retry chain.`);
                return retryNextOrFinalize(_si, 'Gemini', false, 'The model spent its whole budget thinking and never replied \u2014 try rephrasing or switching models.');
              }
            } else if (lastFinishReason === 'SAFETY' || lastFinishReason === 'PROHIBITED_CONTENT' || blockReason) {
              if (!receivedAnyText) {
                // Safety blocks are not retry-friendly across the same provider
                // family (the next Gemini model will block the same prompt). Send
                // the explicit safety error rather than recursing.
                return sendError(AI_TEMPORARY_FAILURE_TEXT);
              }
              sendChunk('\n\n_…response stopped early (safety filter)._');
            } else if (lastFinishReason === 'RECITATION') {
              if (!receivedAnyText) {
                return sendError(AI_TEMPORARY_FAILURE_TEXT);
              }
              sendChunk('\n\n_…response stopped early (recitation filter)._');
            }
          }
          if (!receivedAnyText && blockReason) {
            return sendError(AI_TEMPORARY_FAILURE_TEXT);
          }
          // Clean stream close. retryNextOrFinalize handles both "had text → done"
          // and "no text → walk the fallback chain" without a separate code path.
          return retryNextOrFinalize(_si, 'Gemini', receivedAnyText, null);
        });
        reader.on('error', (err) => {
          console.error('❌ Gemini stream reader error:', err?.message || err);
          // If we already streamed text, end gracefully — the client will
          // keep what it has rather than wiping it with a generic error.
          return retryNextOrFinalize(_si, 'Gemini', receivedAnyText, AI_TEMPORARY_FAILURE_TEXT);
        });
        return; // stream connected, exit handler

      } else if (actualModel.includes('grok')) {
        if (!process.env.XAI_API_KEY) { if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1); return sendError(AI_TEMPORARY_FAILURE_TEXT); }
        const ab = makeProviderAbort();
        let grokRes;
        try {
          console.log(`📡 Calling xAI Grok: ${actualModel}...`);
          const { system: strmGrokSys, user: strmGrokUser } = splitPromptForProviderWithWeb(prompt);
          const strmGrokMsgs = [];
          if (strmGrokSys) strmGrokMsgs.push({ role: 'system', content: strmGrokSys });
          let grokContent = strmGrokUser;
          if (imageUrls.length > 0) {
            const parts = [{ type: 'text', text: strmGrokUser }];
            for (const url of imageUrls) parts.push({ type: 'image_url', image_url: { url } });
            grokContent = parts;
          }
          strmGrokMsgs.push({ role: 'user', content: grokContent });
          const _strmGrokCap = clampForProvider(pickOutputCap({
            hasImages: imageUrls.length > 0,
            deepResearch,
            // No intent: pre-generation classifyActionType always returns
            // 'chat_short' (2500 cap), which was the actual cause of MAX_TOKENS
            // hitting on long replies. Falling through to OUTPUT_CAPS.chat
            // gives the model real room to finish its thought.
          }), actualModel);
          grokRes = await fetch('https://api.x.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: actualModel,
              messages: strmGrokMsgs,
              max_tokens: _strmGrokCap,
              stream: true,
            }),
            signal: ab.signal,
          });
          ab.clear();
          console.log(`✅ Grok responded: ${grokRes.status}`);
        } catch (e) {
          ab.clear();
          console.error('❌ Grok stream fetch failed:', e.message);
          if (_si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        if (!grokRes.ok) {
          const err = await grokRes.json().catch(() => ({}));
          console.error('❌ Grok API error:', err);
          if (RETRYABLE_STATUSES.has(grokRes.status) && _si + 1 < _streamModels.length) return tryStreamAt(_si + 1);
          return sendError(AI_TEMPORARY_FAILURE_TEXT);
        }
        streamActivity = Date.now();
        console.log('✅ Grok stream connected, reading tokens...');
        const reader = grokRes.body;
        let buffer = '';
        let receivedAnyText = false;
        const processGrokPayload = (payload) => {
          if (!payload || payload === '[DONE]') return;
          try {
            const parsed = JSON.parse(payload);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) { receivedAnyText = true; sendChunk(delta); }
          } catch {}
        };
        reader.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const payload = trimmed.slice(6);
            if (payload === '[DONE]') return sendDone();
            processGrokPayload(payload);
          }
        });
        reader.on('end', () => {
          if (buffer.trim()) {
            for (const line of buffer.split('\n')) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;
              const payload = trimmed.slice(6);
              if (payload === '[DONE]') return sendDone();
              processGrokPayload(payload);
            }
            buffer = '';
          }
          return retryNextOrFinalize(_si, 'Grok', receivedAnyText, null);
        });
        reader.on('error', (err) => {
          console.error('❌ Grok stream reader error:', err?.message || err);
          return retryNextOrFinalize(_si, 'Grok', receivedAnyText, AI_TEMPORARY_FAILURE_TEXT);
        });
        return; // stream connected, exit handler

      } // end provider if/else
      // No provider matched the model id at this _si. Surface a clear error rather
      // than silently dropping the request — happens if a future model alias is
      // requested before the routing branches above are updated.
      return sendError(AI_TEMPORARY_FAILURE_TEXT);
      }; // end tryStreamAt

      // ── Agent loop short-circuit ─────────────────────────────────────
      // When useTools is on we route through chat-agent-loop.js instead
      // of the legacy single-shot tryStreamAt chain. The legacy chain has
      // 4-provider fallback and stream-level retries that don't translate
      // cleanly to a multi-hop tool loop (each hop has its own messages
      // history that depends on previous tool results), so we keep them
      // separate. If the agent loop errors before producing any text, we
      // fall through to the legacy chain — the user still gets a reply,
      // just without tool access.
      //
      // The dispatcher in chat-agent-loop.js picks the right provider
      // impl (openai / grok / anthropic / gemini) based on `provider`,
      // so we don't branch on model id here — providerForModel does it.
      const toolProvider = useTools ? providerForModel(actualModel) : null;
      // Local Mode: when the desktop app enabled it, offer the file/terminal
      // tools alongside the regular chat tools. They execute client-side; the
      // server only relays. Register a per-turn stream so the desktop can post
      // results back and match them to the awaiting call.
      const disclosedLocalToolNames = (Array.isArray(streamChatToolNames) ? streamChatToolNames : [])
        .filter((n) => LOCAL_TOOL_NAMES.includes(n));
      const streamLocalToolsEnabled =
        useTools && !!toolProvider && streamLocalMode && disclosedLocalToolNames.length > 0;
      if (streamLocalToolsEnabled) {
        localToolStreamId = `lt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      }
      let effectiveChatToolNames = streamChatToolNames;
      if (streamLocalToolsEnabled) {
        effectiveChatToolNames = Array.isArray(streamChatToolNames) ? [...streamChatToolNames] : [];
        if (req.user?.id) registerLocalToolStream(localToolStreamId, req.user.id);
      }
      if (useTools && toolProvider) {
        _ck(`entering agent loop (${toolProvider})`);
        const { system: rawAgentSys, user: agentUser } = splitPromptForProviderWithWeb(prompt);
        // Local Mode system guidance. Without this the model has the local_*
        // schemas but nothing in the prompt saying access is LIVE — and if an
        // earlier turn errored (e.g. a declined permission prompt), the
        // conversation history is full of its own "local access isn't enabled"
        // claims, which it will keep parroting instead of retrying the tools.
        const agentSys = streamLocalToolsEnabled
          ? rawAgentSys +
            '\n\n[LOCAL MODE — ACTIVE]\n' +
            'Local Mode is ON for this turn. You HAVE live access to the user\'s Mac through the ' +
            `local_* tools disclosed this turn: ${disclosedLocalToolNames.join(', ')}. ` +
            'Call only those tools. If a needed local action is not listed, say so rather than ' +
            'inventing a tool name. ' +
            (disclosedLocalToolNames.includes('local_edit_file')
              ? 'To CHANGE a file the user already has, prefer local_edit_file — it replaces an ' +
                'exact snippet and leaves the rest of the file untouched; read the file first so ' +
                'oldText matches verbatim. Use local_write_file only for new files or full rewrites. '
              : '') +
            'Filesystem access is scoped to the folders the user synced with LYKN' +
            (disclosedLocalToolNames.includes('local_synced_folders')
              ? ' — call local_synced_folders first when you are unsure what you can reach.'
              : '.') +
            ' Reads may show the user a one-time permission prompt; writes and risky commands ' +
            'always ask them per action. When the user asks about their files, folders, apps, or ' +
            'system, CALL THE TOOLS — never claim local access is unavailable or ask them to ' +
            'enable it (the switch is already on). Ignore any earlier statements in this ' +
            'conversation that said local access was off; those were transient errors. If a tool ' +
            'returns an error, relay that exact error honestly instead of inventing a reason. ' +
            'When the ask targets a place on their MACHINE (Downloads, Desktop, Documents, a ' +
            'folder, a drive), use ONLY the local_* tools — NEVER call lykn_searchVault. ' +
            (disclosedLocalToolNames.includes('local_pull_file')
              ? 'When local_pull_file succeeds, the file is automatically shown to the user as a ' +
                'card in the chat — NEVER write its URL into your reply.'
              : '') +
            (disclosedLocalToolNames.includes('local_browser_agent')
              ? '\n\n[BROWSER AGENT — AVAILABLE]\n' +
                'You also have local_browser_agent: it hands a task to LYKN\'s browser agent, which ' +
                'opens a real tab on the user\'s desktop and operates websites while they watch. ' +
                'Use it when the user asks you to go DO something on a website or in a web product. ' +
                'Use lykn_web_search / lykn_web_fetch when you just need to read the web.'
              : '')
          : rawAgentSys;
        if (streamLocalToolsEnabled) {
          console.log(
            `🖥️ local tools offered: ${disclosedLocalToolNames.length}/${LOCAL_TOOL_NAMES.length}`,
          );
        }

        // Build provider-correct user content shape. Multimodal image
        // attachments need provider-native parts; text-only turns just
        // pass the string. A function (not a one-shot) because the forced-
        // tool fallback below may re-run the turn on a DIFFERENT provider,
        // which needs its own content shape.
        const buildAgentUserContent = async (providerId) => {
          if (imageUrls.length === 0) return agentUser;
          if (providerId === 'openai' || providerId === 'grok') {
            return [
              { type: 'text', text: agentUser },
              ...imageUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
            ];
          }
          if (providerId === 'anthropic') {
            const parts = [{ type: 'text', text: agentUser }];
            for (const url of imageUrls) {
              if (url.startsWith('data:image/')) {
                const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
                if (match) parts.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
              } else {
                parts.push({ type: 'image', source: { type: 'url', url } });
              }
            }
            return parts;
          }
          if (providerId === 'gemini') {
            const parts = [{ text: agentUser }];
            for (const url of imageUrls) {
              try {
                if (url.startsWith('data:image/')) {
                  const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
                  if (match) parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
                } else {
                  // Gemini doesn't accept arbitrary URLs in inline_data —
                  // fetch + base64 like the legacy path does. Best-effort.
                  const imgRes = await safeFetch(url);
                  if (imgRes.ok) {
                    const buf = Buffer.from(await imgRes.arrayBuffer());
                    const mime = imgRes.headers.get('content-type') || 'image/png';
                    parts.push({ inline_data: { mime_type: mime, data: buf.toString('base64') } });
                  }
                }
              } catch (e) {
                console.warn('⚠️ agent loop: failed to fetch image for Gemini:', e.message);
              }
            }
            return parts;
          }
          return agentUser;
        };

        // Resolve Gemini alias quirks the same way the legacy path does
        // so a user picking the alias `gemini-flash-latest` ends up
        // hitting a real Gemini model id Google currently routes.
        let agentModel = actualModel;
        if (toolProvider === 'gemini') {
          if (agentModel === 'gemini-pro' || agentModel === 'gemini-1.5-flash') agentModel = 'gemini-flash-latest';
          else if (agentModel === 'gemini-1.5-pro') agentModel = 'gemini-pro-latest';
          else if (agentModel === 'gemini-3-pro-preview') agentModel = 'gemini-3.1-pro-preview';
        } else if (toolProvider === 'anthropic') {
          agentModel = resolveAnthropicModel(actualModel);
        }

        const agentCacheKey = `lykn-${(req.user?.id || 'anon').slice(0, 32)}`;
        // An editable artifact is only sent for an actual mutation turn (plain
        // discussion uses a discussOnly stub), so require its builder just like
        // a fresh Build/Create commission. Merely offering the one-tool
        // allowlist lets a provider stream introductory prose and then fail with
        // zero calls, leaving no preview or installable update.
        const forcedToolNameForTurn = forceImage
          ? 'lykn_generate_image'
          : (artifactToolName ||
            (activeArtifactEditable ? String(activeArtifact.toolName || '') : '') ||
            undefined);

        // Forced-tool turns (artifact builds, image gen) get a provider
        // fallback chain: grok-4.5 reproducibly truncates its stream mid-
        // reasoning on some forced-tool requests (every time an image is
        // attached, intermittently otherwise), which used to end the turn
        // "successfully" with no artifact and leave the user staring at
        // nothing. When the forced tool never completes on the primary
        // provider, the whole turn re-runs on the next available one.
        const agentAttempts = [{ provider: toolProvider, model: agentModel }];
        if (forcedToolNameForTurn) {
          // Order matches the coded-artifact reroute preference: Opus 4.8 →
          // GPT-5.6 → Gemini 3.1 Pro. Coded builds use the stronger coders;
          // non-artifact forced tools (image gen) just need any tool-capable
          // provider, so the same chain is fine there too.
          const fallbacks = [
            { provider: 'anthropic', model: 'claude-opus-4-8', available: !!process.env.ANTHROPIC_API_KEY },
            { provider: 'openai', model: 'gpt-5.6-sol', available: !!process.env.OPENAI_API_KEY },
            { provider: 'gemini', model: 'gemini-3.1-pro-preview', available: !!process.env.GOOGLE_API_KEY },
          ];
          for (const f of fallbacks) {
            if (f.available && f.provider !== toolProvider) {
              agentAttempts.push({ provider: f.provider, model: f.model });
            }
          }
        }

        try {
          const runAttempt = async ({ provider: attemptProvider, model: attemptModel }, attemptSignal) => runAgentLoop({
            provider: attemptProvider,
            model: attemptModel,
            systemPrompt: agentSys,
            userContent: await buildAgentUserContent(attemptProvider),
            // We deliberately do NOT thread `conversation` through here:
            // the [CONVERSATION] block already lives inside `prompt` via
            // buildLyknStreamPrompt, so passing priorTurns again would
            // double-count. The agent-loop's priorTurns is for callers
            // that don't pre-bake conversation into the system prompt.
            priorTurns: [],
            // pickOutputCap with no intent → OUTPUT_CAPS.chat (same as the
            // non-tool path uses). Tool loops can run multiple hops; the cap
            // is per-hop, so the model gets full headroom on the final reply
            // after tool results land. Coded-artifact turns get the big cap —
            // the whole React component must fit in one tool-call argument.
            maxOutputTokens: codedArtifactTurn || videoRenderLikelyTurn
              ? clampForProvider(OUTPUT_CAPS.coded_artifact, attemptModel)
              : clampForProvider(pickOutputCap({
                  hasImages: imageUrls.length > 0,
                  deepResearch,
                }), attemptModel),
            // Longer tool loops for fresh coded builds. Open-panel refine uses
            // the short edit hop cap instead (one batched patch, not 28 hops).
            codingMode: Boolean(codedArtifactTurn && !activeArtifactEditable),
            // Research reports must finish embeds + Sources even when a
            // provider's per-call ceiling truncates mid-fence.
            continueIncompleteResearch: Boolean(deepResearch),
            promptCacheKey: agentCacheKey,
            chatToolNames: effectiveChatToolNames,
            forceToolName: forcedToolNameForTurn,
            env: process.env,
            ctx: (() => {
              const chatModelLabel = resolveChatModelLabel({
                customModelName: streamCustomModelCtx.customModel?.name,
                modelId: attemptModel,
              });
              const base = buildChatToolCtx(req, {
                chatModelLabel,
                boundProjectId: streamBoundProjectId,
                boardProjectId: streamBoardProjectId,
                // Edit turns: short hop loop + one ship — see chat-agent-loop.js.
                editingArtifact: Boolean(activeArtifactEditable),
                // Surgical edit paths — open artifact source for patch-in-place.
                activeArtifactCode:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact'
                    ? String(activeArtifact.code || '')
                    : null,
                activeArtifactFiles:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact'
                    ? (Array.isArray(activeArtifact.files) ? activeArtifact.files : null)
                    : null,
                activeArtifactEntry:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact'
                    ? (typeof activeArtifact.entry === 'string' ? activeArtifact.entry : null)
                    : null,
                activeArtifactTodos:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact'
                    ? (Array.isArray(activeArtifact.todos) ? activeArtifact.todos : null)
                    : null,
                activeArtifactRuntimeErrors:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_react_artifact'
                    ? (Array.isArray(activeArtifact.runtimeErrors) ? activeArtifact.runtimeErrors : null)
                    : null,
                activeArtifactSections:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_template'
                    ? (Array.isArray(activeArtifact.sections) ? activeArtifact.sections : null)
                    : null,
                activeArtifactContent:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_manage_file'
                    ? String(activeArtifact.fileContent || '')
                    : activeArtifactEditable &&
                        activeArtifact.toolName === 'lykn_build_template' &&
                        typeof activeArtifact.content === 'string'
                      ? activeArtifact.content
                      : null,
                activeArtifactHeaders:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_spreadsheet'
                    ? (Array.isArray(activeArtifact.headers) ? activeArtifact.headers : null)
                    : null,
                activeArtifactRows:
                  activeArtifactEditable && activeArtifact.toolName === 'lykn_build_spreadsheet'
                    ? (Array.isArray(activeArtifact.rows) ? activeArtifact.rows : null)
                    : null,
                activeArtifactTitle:
                  activeArtifactEditable ? String(activeArtifact.title || '') : null,
                activeArtifactTheme:
                  activeArtifactEditable && typeof activeArtifact.theme === 'string'
                    ? activeArtifact.theme
                    : null,
                activeArtifactFont:
                  activeArtifactEditable && typeof activeArtifact.font === 'string'
                    ? activeArtifact.font
                    : null,
                // Merely editing an installed app never authorizes replacing all
                // of its source. Full rewrites require explicit redesign/fresh
                // intent; ordinary follow-ups stay as targeted patches.
                allowFullRewrite: redesignArtifactAsk || buildModeFresh,
                allowStyleChange:
                  redesignArtifactAsk || buildModeFresh || styleChangeArtifactAsk,
              });
              if (mcpChatTools.length) {
                base.extraChatTools = mcpChatTools;
                base.extraChatToolsByName = Object.fromEntries(mcpChatTools.map((t) => [t.name, t]));
              }
              // Remotion renders (lykn_render_video) run 1-4 real minutes with
              // no provider stream — ping the stall watchdog on every frame and
              // surface throttled percent updates so the client sees progress.
              let lastVideoStatusAt = 0;
              base.onRenderProgress = (progress) => {
                noteStreamActivity();
                const now = Date.now();
                if (now - lastVideoStatusAt > 4000) {
                  lastVideoStatusAt = now;
                  sendStatus(`Rendering video… ${Math.round((Number(progress) || 0) * 100)}%`);
                }
              };
              // Local Mode: mark the local tools so the loop hands them to the
              // desktop client instead of executing them here, and provide the
              // awaiter that ships the call out and waits for the posted result.
              if (streamLocalToolsEnabled && localToolStreamId) {
                base.localToolNames = disclosedLocalToolNames;
                base.awaitLocalTool = (call, record) =>
                  new Promise((resolve) => {
                    const start = Date.now();
                    const finish = (payload) => {
                      const result = payload && typeof payload === 'object'
                        ? payload
                        : { ok: false, error: 'malformed local tool result' };
                      const isError = result.ok === false;
                      console.log(
                        `🖥️ local tool ${call.name} ← ${isError ? `ERROR: ${String(result.error || '').slice(0, 120)}` : 'ok'} (${Date.now() - start}ms)`,
                      );
                      record({
                        id: call.id,
                        name: call.name,
                        args: call.args,
                        status: isError ? 'error' : 'done',
                        result,
                        latencyMs: Date.now() - start,
                      });
                      resolve({ payload: result, isError, latencyMs: Date.now() - start });
                    };
                    const entry = localToolStreams.get(localToolStreamId);
                    if (!entry) {
                      finish({ ok: false, error: 'Local mode session is no longer active.' });
                      return;
                    }
                    // Tell the desktop client to run this tool now.
                    console.log(`🖥️ local tool ${call.name} → awaiting desktop client`);
                    record({
                      id: call.id,
                      name: call.name,
                      args: call.args,
                      status: 'awaiting_client',
                      localStreamId: localToolStreamId,
                    });
                    noteStreamActivity();
                    const timer = setTimeout(() => {
                      entry.pending.delete(call.id);
                      finish({ ok: false, error: 'The desktop app did not return a result in time.' });
                    }, LOCAL_TOOL_WAIT_MS);
                    entry.pending.set(call.id, (posted) => {
                      clearTimeout(timer);
                      finish(posted);
                    });
                  });
              }
              if (!streamOrchestrationCtx?.isMainAgent) return base;
              const mainModelId = streamOrchestrationCtx.mainModelId;
              const chatId = streamChatId;
              return {
                ...base,
                orchestration: {
                  isMainAgent: true,
                  subModelIds: streamOrchestrationCtx.subModelIds,
                  roster: streamOrchestrationCtx.roster,
                },
                runSubModelDelegate: ({ subModelId, taskInstruction, context }) =>
                  runSubModelDelegate({
                    client: supabaseAdmin,
                    userId: req.user?.id,
                    subModelId,
                    taskInstruction,
                    context,
                  }),
                createSubModelTask: ({ subModelId, subModelName, taskInstruction, context }) =>
                  createSubModelTask(supabaseAdmin, {
                    userId: req.user?.id,
                    mainModelId,
                    subModelId,
                    subModelName,
                    chatId,
                    taskInstruction,
                    context,
                  }),
                enqueueSubModelTask: ({ taskId }) =>
                  enqueueSubModelTask({
                    client: supabaseAdmin,
                    taskId,
                    userId: req.user?.id,
                  }),
                listSubModelTasks: ({ status, limit } = {}) =>
                  listSubModelTasks(supabaseAdmin, req.user?.id, {
                    mainModelId,
                    chatId,
                    status,
                    limit,
                  }),
                getSubModelTask: (taskId) =>
                  getSubModelTask(supabaseAdmin, req.user?.id, taskId),
              };
            })(),
            signal: attemptSignal,
            onTextChunk: (t) => sendChunk(t),
            onToolCall: (evt) => sendToolCall(evt),
            onStatus: (s) => sendStatus(s),
            onActivity: noteStreamActivity,
          });

          // Per-attempt silence watchdog (coded-artifact / video builds only).
          // grok-4.5 stops sending bytes entirely during reasoning pauses on
          // big build prompts; most recover within ~90s, but when one runs
          // longer we abort THIS attempt and re-run the turn on the next
          // provider in the chain (Opus → GPT → Gemini) instead of letting
          // the global stall watchdog kill the whole stream with an error.
          // Not applied to other forced-tool turns (e.g. image gen): their
          // tool execution can legitimately go quiet mid-run, and aborting
          // there risks retrying a tool that already fired.
          const ATTEMPT_STALL_MS = 150000;
          const attemptWatchdogEligible =
            forcedToolNameForTurn && agentAttempts.length > 1 &&
            (codedArtifactTurn || videoRenderLikelyTurn);

          let agentResult;
          for (let ai = 0; ai < agentAttempts.length; ai++) {
            const attempt = agentAttempts[ai];
            const attemptAbort = new AbortController();
            abortCurrentAgentAttempt = () => attemptAbort.abort();
            let attemptStalled = false;
            let attemptWatchdog = null;
            if (attemptWatchdogEligible && ai + 1 < agentAttempts.length) {
              attemptWatchdog = setInterval(() => {
                if (Date.now() - streamActivity > ATTEMPT_STALL_MS) {
                  attemptStalled = true;
                  console.warn(`[stream] ${attempt.provider}/${attempt.model} silent for ${Math.round(ATTEMPT_STALL_MS / 1000)}s — aborting attempt to fall back`);
                  attemptAbort.abort();
                }
              }, 5000);
            }
            try {
              agentResult = await runAttempt(attempt, attemptAbort.signal);
            } finally {
              if (attemptWatchdog) clearInterval(attemptWatchdog);
              abortCurrentAgentAttempt = null;
            }
            _ck(`agent loop ${agentResult.reason} (provider=${attempt.provider}, model=${attempt.model}, tools=${agentResult.toolCalls.length}, hadText=${agentResult.hadText})`);

            // Client already gone (disconnect, global stall, hard kill) —
            // don't waste another provider run on a dead socket.
            if (res.writableEnded) return;

            // Did the forced tool actually complete? (No forced tool → n/a.)
            const forcedToolOk = !forcedToolNameForTurn || (agentResult.toolCalls || []).some(
              (tc) => tc && tc.name === forcedToolNameForTurn && tc.status === 'done' && tc.result?.ok !== false,
            );
            if (agentResult.ok && forcedToolOk) break;

            // Transport-level failures ("fetch failed", SSL/TLS alerts, resets)
            // are one-provider problems just like rate limits — another provider
            // can still complete the build. Without this, a single flaky grok
            // connect dropped the whole turn to the legacy no-tools stream and
            // the user got prose instead of an artifact.
            const attemptErrMsg = String(agentResult.errorMessage || '');
            const isNetworkFetchError =
              /fetch failed|network|econn|etimedout|socket hang up|ssl|tls|eai_again|und_err|terminated|dns/i.test(attemptErrMsg);
            const canFallback =
              forcedToolNameForTurn && !forcedToolOk && ai + 1 < agentAttempts.length &&
              (attemptStalled ||
               agentResult.reason === 'forced_tool_incomplete' ||
               (agentResult.reason === 'error' &&
                (isNetworkFetchError || isRetryableProviderError(attemptErrMsg))));
            if (!canFallback) break;

            const next = agentAttempts[ai + 1];
            console.warn(`[stream] forced tool never completed on ${attempt.provider}/${attempt.model} (${agentResult.reason}${attemptStalled ? ', attempt stalled' : ''}) — retrying turn on ${next.provider}/${next.model}`);
            sendStatus('Still working on it…');
          }

          if (agentResult.ok && agentResult.hadText) {
            return sendDone();
          }
          // Empty text on hop_cap is rare but possible (model called tools
          // but never wrote a reply). Rather than a confusing "try rephrasing",
          // confirm what actually happened based on the tools that succeeded —
          // e.g. saving a note to the vault should read as a clear success.
          if (agentResult.ok && !agentResult.hadText) {
            const ok = (agentResult.toolCalls || []).filter((tc) => tc && !tc.isError);
            const names = ok.map((tc) => String(tc.name || ''));
            let msg;
            if (names.some((n) => /vault|note/i.test(n))) {
              msg = 'Done — I saved that to your vault.';
            } else if (names.some((n) => /(^|_)(create|add|update|save|send|schedule|delete|set)/i.test(n))) {
              msg = 'Done — I completed that for you.';
            } else if (ok.length) {
              msg = 'Done.';
            } else {
              msg = 'I ran the tools but didn\'t produce a written reply — try rephrasing the question.';
            }
            sendChunk(msg);
            return sendDone();
          }
          // Agent loop errored. If we already streamed some text, finish
          // gracefully; otherwise fall through to the legacy non-tool
          // path so the user still gets an answer.
          if (agentResult.hadText) {
            return sendDone();
          }
          console.warn(`[stream] agent loop failed (${toolProvider}, ${agentResult.reason}): ${agentResult.errorMessage}. Falling back to legacy stream.`);
        } catch (agentErr) {
          console.error('❌ agent loop crashed:', agentErr?.message || agentErr);
        }
        // fallthrough — legacy stream below
      }

      // Stream already terminated (client disconnect / stall abort) — the
      // legacy chain would silently re-fetch a provider against a dead socket.
      if (res.writableEnded) return;
      await tryStreamAt(0);
    } catch (error) {
      console.error('❌ Stream error:', error.message);
      const userMsg = AI_TEMPORARY_FAILURE_TEXT;
      if (!res.headersSent) {
        res.status(500).json({ error: userMsg });
      } else {
        try { res.write(`data: ${JSON.stringify({ error: userMsg })}\n\n`); res.end(); } catch {}
      }
    }
  });
}
