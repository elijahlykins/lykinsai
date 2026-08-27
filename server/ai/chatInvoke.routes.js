// POST /api/ai/invoke — non-streaming Chat. `returnActions` remains a live
// public contract on this route.
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
  messageWantsAgentTools,
  messageWantsPageFetch,
  messageWantsProjectContext,
  messageWantsSavedRecall,
  messageWantsWebTools,
} from '../../mcp-tools/chatIntentSignals.js';
import { resolveChatTurnDisclosure } from '../../mcp-tools/firstPartyCapabilities.js';
import { buildSlimChatToolGuidance } from '../../mcp-tools/chatToolGuidance.js';
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

export function registerAiInvokeRoute(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  checkAiUsageLimit,
  sanitizePromptBundle,
  resolveProductionChatMemory,
}) {
  app.post('/api/ai/invoke', requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit, async (req, res) => {
    try {
      const normalizedModel = normalizeRequestedModel(req.body?.model);
      const incomingImageUrls = Array.isArray(req.body?.imageUrls) ? req.body.imageUrls : [];
      console.log('📥 Received AI request:', { 
        model: normalizedModel,
        promptLength: req.body?.prompt?.length,
        textLength: req.body?.text?.length,
        intent: req.body?.intent,
        hasModel: !!normalizedModel,
        hasPrompt: !!req.body?.prompt,
        hasText: !!req.body?.text,
        imageCount: incomingImageUrls.length,
        imageUrlPrefixes: incomingImageUrls.map(u => String(u || '').slice(0, 60)),
      });
      
      let { intent, text, returnActions, context, knowledgeBase, projectId, conversation, conversationMemory, imageUrls: rawImageUrls, responseLength, hasFocusedBricks, skipWebSearch, workspaceContext } = req.body;
      let { userPrompt } = req.body;
      const aiName = req.body?.aiName;
      // Chat-bar "+" Web search / Deep research opt-in (non-streaming fallback).
      // Also auto-armed below for live-freshness asks in regular chat.
      let forceWebSearch = req.body?.forceWebSearch === true;
      const deepResearch = req.body?.deepResearch === true;
      const researchSourcePref = String(req.body?.researchSourcePref || 'all')
        .trim()
        .toLowerCase()
        .slice(0, 32);
      const translateMode = req.body?.translateMode === true;
      let model = normalizedModel;
      const imageUrls = (Array.isArray(rawImageUrls) ? rawImageUrls : [])
        .map((u) => String(u || '').trim())
        .filter((u) => u.startsWith('http') || u.startsWith('data:image/'))
        .slice(0, 10);
      let { prompt } = req.body;

      // SECURITY (Agent 04): strip tool-call & system-prompt injection syntax
      // from EVERY user-controlled string before it enters the prompt builder
      // and the model call chain. Applied to:
      //   • top-level free-form fields (text, prompt, userPrompt)
      //   • each conversation[i].content (a prior turn full of injection
      //     syntax is just as risky as a fresh message)
      //   • workspaceContext / knowledgeBase / context (server-assembled but
      //     contain user-typed vault/project text — defense in depth against
      //     vault-roundtrip injection)
      // The output stripper in chat-agent-loop.js already runs over model
      // text deltas; this is the input-side mirror.
      // SECURITY (Agent 06): sanitizePromptBundle uses the with-count
      // variants and emits ONE structured INJECTION_STRIPPED event per
      // request when fragments are stripped (NEVER the matched text — only
      // the aggregate count + which fields were scanned).
      {
        const _bundle = sanitizePromptBundle({
          req,
          fields: { text, prompt, userPrompt, context, knowledgeBase, workspaceContext, conversationMemory },
          turns: conversation,
          route: '/api/ai/invoke',
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

      if (
        !forceWebSearch &&
        !deepResearch &&
        !translateMode &&
        webSearchIntent.shouldForceWebSearch(String(text || ''), { conversation })
      ) {
        forceWebSearch = true;
        console.log('🔍 Invoke: auto-armed live web search (regular chat freshness / explicit ask)');
      }

      // SECURITY (Agent 04): hard ceiling on combined user-controlled input.
      // Defense-in-depth on top of the 1MB express.json() limit and the
      // existing AI_BUDGETS per-section truncation. 200K chars is generous
      // (≈ 50K tokens, comfortably above any model's working context window
      // we route to today) — anything larger is an abuse signal, not a
      // legitimate request.
      const _userInputLen = (text?.length || 0) + (prompt?.length || 0) + (userPrompt?.length || 0);
      if (_userInputLen > MAX_USER_INPUT_CHARS) {
        return res.status(400).json({ error: 'prompt_too_large' });
      }

      // Enforce plan tier: silently downgrade locked models instead of erroring.
      const invokePlan = await resolveUserPlan(req.user?.id, req.user?.email);
      if (!isModelAllowedForPlan(model, invokePlan.modelTier)) {
        const downgraded = defaultModelForTier(invokePlan.modelTier);
        console.log(`🔒 Model ${model} locked for plan ${invokePlan.planId} — downgrading to ${downgraded}`);
        res.setHeader('X-Model-Downgraded', `${model}->${downgraded}`);
        res.setHeader('X-Plan', invokePlan.planId);
        model = downgraded;
      }
      const customModelId = CUSTOM_MODELS_ENABLED
        ? String(req.body?.customModelId || '').trim() || null
        : null;
      let customModelCtx = { overlay: null, model, customModel: null };
      if (customModelId && req.user?.id) {
        customModelCtx = await loadCustomModelForChat(
          req.user.id,
          customModelId,
          model,
          invokePlan.modelTier,
        );
        model = customModelCtx.model;
        if (customModelCtx.customModel) {
          try {
            res.setHeader('X-Custom-Model', customModelCtx.customModel.id);
            res.setHeader('X-Custom-Model-Name', customModelCtx.customModel.name || '');
          } catch { /* ignore */ }
        }
        if (customModelCtx.overlay?.responseLength) {
          responseLength = customModelCtx.overlay.responseLength;
        }
        if (customModelCtx.customModel && !(customModelCtx.overlay?.promptSections?.length)) {
          console.warn(
            `⚠️ Custom model ${customModelId} loaded but prompt overlay is empty (status=${customModelCtx.customModel.status})`,
          );
        }
      }
      // Custom AI instructions are a Studio+ feature. Basic-tier callers get
      // the userPrompt silently stripped so the server prompt builder treats
      // them as a vanilla request.
      if (invokePlan.modelTier === 'basic' && userPrompt) {
        userPrompt = undefined;
        res.setHeader('X-Feature-Stripped', 'user_prompt');
      }

      // Models routinely emit JSON with unescaped quotes inside string values
      // (e.g. `"content":"Text overlay: *"Think clearly."*"`). Strict JSON.parse
      // aborts at the first stray quote, so we walk the buffer and escape any
      // double-quote that appears inside a string literal but is NOT followed
      // by a closing-context character (`,`, `}`, `]`, `:`, EOF).
      const repairUnescapedQuotes = (jsonStr) => {
        let result = '';
        let i = 0;
        let inString = false;
        let escape = false;
        while (i < jsonStr.length) {
          const c = jsonStr[i];
          if (escape) { result += c; escape = false; i++; continue; }
          if (c === '\\') { result += c; escape = true; i++; continue; }
          if (c === '"') {
            if (!inString) { inString = true; result += c; i++; continue; }
            let j = i + 1;
            while (j < jsonStr.length && /\s/.test(jsonStr[j])) j++;
            const next = jsonStr[j];
            if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
              inString = false;
              result += c;
              i++;
              continue;
            }
            result += '\\"';
            i++;
            continue;
          }
          result += c;
          i++;
        }
        return result;
      };

      const safeJsonParse = (str, fallback) => {
        try { return JSON.parse(str); } catch {}
        try { return JSON.parse(repairUnescapedQuotes(String(str))); } catch {}
        return fallback;
      };

      const repairTruncatedJson = (text) => {
        let s = String(text || "").trim();
        if (!s.startsWith("{")) return null;

        const tryRepair = (input) => {
          let t = input;
          // Strip trailing incomplete tokens: commas, colons, partial keys/values
          t = t.replace(/,\s*$/, "");
          t = t.replace(/,\s*"[^"]*$/, "");    // trailing incomplete key like ,"blo
          t = t.replace(/:\s*$/, ": null");      // trailing colon with no value
          t = t.replace(/:\s*"[^"]*$/, ': ""'); // trailing incomplete string value

          let braces = 0, brackets = 0, inStr = false, esc = false;
          for (let i = 0; i < t.length; i++) {
            const c = t[i];
            if (esc) { esc = false; continue; }
            if (c === '\\' && inStr) { esc = true; continue; }
            if (c === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (c === '{') braces++;
            else if (c === '}') braces--;
            else if (c === '[') brackets++;
            else if (c === ']') brackets--;
          }
          if (inStr) t += '"';
          for (let i = 0; i < brackets; i++) t += "]";
          for (let i = 0; i < braces; i++) t += "}";
          return safeJsonParse(t, null);
        };

        // Try direct repair first, then progressively strip more trailing content
        let parsed = tryRepair(s);
        if (!parsed) {
          const lastComma = s.lastIndexOf(",");
          if (lastComma > 0) parsed = tryRepair(s.slice(0, lastComma));
        }
        if (parsed && typeof parsed === "object") {
          console.log("[JSON-repair] Successfully repaired truncated JSON");
          return parsed;
        }
        return null;
      };

      const extractFirstJsonObject = (text) => {
        const raw = String(text ?? "").trim();
        if (!raw) return null;
        const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        const candidate = fence ? String(fence[1] || "").trim() : raw;
        if (candidate.startsWith("{") && candidate.endsWith("}")) {
          const parsed = safeJsonParse(candidate, null);
          if (parsed && typeof parsed === "object") return parsed;
        }
        const first = candidate.indexOf("{");
        const last = candidate.lastIndexOf("}");
        if (first >= 0 && last > first) {
          const slice = candidate.slice(first, last + 1);
          const parsed = safeJsonParse(slice, null);
          if (parsed && typeof parsed === "object") return parsed;
        }
        // Attempt to repair truncated JSON (e.g., from token limit cutoff)
        if (first >= 0) {
          const repaired = repairTruncatedJson(candidate.slice(first));
          if (repaired) return repaired;
        }
        return null;
      };

      const buildPromptFromIntent = (rawIntent, rawText) => {
        const i = String(rawIntent || "").trim().toLowerCase();
        const t = String(rawText || "").trim();
        if (!t) return "";

        if (i === "summarize") {
          return `Summarize the user's text clearly and concisely.
  - Use 5-8 bullet points.
  - If the text is short, keep it to 3-5 bullets.
  - Do not mention system messages.

  Text:
  ${t}
  `;
        }
        if (i === "rewrite") {
          return `Rewrite the user's text to be clearer and better written.
  - Preserve meaning.
  - Keep it roughly the same length unless the user asked otherwise.
  - Do not mention system messages.

  Text:
  ${t}
  `;
        }
        if (i === "brainstorm") {
          return `Brainstorm helpful ideas for the user's prompt.
  - Provide 8-15 ideas.
  - Prefer actionable, concrete suggestions.
  - Do not mention system messages.

  Prompt:
  ${t}
  `;
        }
        if (i === "outline") {
          return `Create a strong outline for the user's topic.
  - Use a numbered outline with nested bullets.
  - Do not mention system messages.

  Topic:
  ${t}
  `;
        }
        if (i === "explain" || i === "define") {
          return `Explain the user's topic clearly.
  - Keep it concise, but include a simple example if helpful.
  - Do not mention system messages.

  Topic:
  ${t}
  `;
        }
        if (i === "todo" || i === "tasks") {
          return `Extract actionable tasks from the user's text.
  - Return a checklist.
  - Combine duplicates.
  - Do not mention system messages.

  Text:
  ${t}
  `;
        }
        // Default: treat as a question/ask.
        return `Answer the user's question clearly and concisely.
  Do NOT repeat the question. Do NOT mention system messages. Just answer.

  Question:
  ${t}
  `;
      };
      
      // Better validation with detailed error messages
      if (!model) {
        console.error('❌ Missing model in request body');
        return res.status(400).json({ error: 'Missing model parameter' });
      }
      if (!prompt) {
        // Allow "intent + text" (used by Omnia Live AI triggers).
        if (text) prompt = buildPromptFromIntent(intent, text);
      }
      if (!prompt) {
        console.error('❌ Missing prompt/text in request body');
        return res.status(400).json({ error: 'Missing prompt (or provide text + intent)' });
      }

      const kbText = (() => {
        if (!knowledgeBase) return "";
        const raw = typeof knowledgeBase === "string" ? knowledgeBase : JSON.stringify(knowledgeBase);
        const trimmed = String(raw || "").trim();
        if (!trimmed) return "";
        return trimmed.length > AI_BUDGETS.projectSummary ? `${trimmed.slice(0, AI_BUDGETS.projectSummary)}…` : trimmed;
      })();

      const buildLyknChatPrompt = (input) => {
        const latestUserMessage = String(input?.text || "").trim().slice(0, AI_BUDGETS.userPrompt) || String(input?.prompt || "").trim().slice(0, AI_BUDGETS.userPrompt);
        const rawPrompt = String(input?.prompt || "").trim().slice(0, 16000);

        // Tier 3 cost cuts:
        //  1. Static persona is now a module-level constant (`LYKN_CHAT_PERSONA_STATIC`)
        //     so its sha256 is stable and Google's cachedContents hits ~every call.
        //  2. Workspace context is gated by the user's actual intent — we only
        //     embed the (up to 28K-char) Vault + other-boards dump when the user
        //     explicitly asks about saved content / cross-board / Vault items.
        //  3. Board context cap drops from 14K → 4K when the user has focused
        //     bricks (the focused brick is the target; we don't need the whole grid).
        //  4. Response-length / hasProject / image / DETAILED-VAULT toggles are
        //     no longer baked into the persona — the static persona handles all
        //     permutations, dynamic facts go in the dynamic section below.
        const hasFocusedBricks = Boolean(input?.hasFocusedBricks);
        const wsCtxRaw = String(input?.workspaceContext || "").trim();
        const includeWsCtx = wsCtxRaw && shouldEmbedWorkspaceContext(latestUserMessage);
        const wsCtx = includeWsCtx
          ? wsCtxRaw.slice(0, AI_BUDGETS.workspaceContext)
          : "";
        const ctxBudget = hasFocusedBricks ? BOARD_CONTEXT_FOCUSED_CHARS : AI_BUDGETS.canvasTotal;
        const contextText = String(input?.context || "").trim().slice(0, ctxBudget);
        const kbBudget = input?.projectId ? AI_BUDGETS.projectSummaryInProject : AI_BUDGETS.projectSummary;
        const kb = String(input?.knowledgeBase || "").trim().slice(0, kbBudget);
        const convo = compressConversation(input?.conversation);

        const focusedBricksNote = "";

        const imageNote = imageUrls.length > 0
          ? `[ATTACHED_IMAGES]\n${imageUrls.length} image(s) attached as actual pixel data — describe / reference them as needed.`
          : "";

        const responseLengthNote = buildResponseLengthNote(responseLength);

        const userPromptSection = userPrompt && String(userPrompt).trim()
          ? `[USER_PREFERENCES]\nThe user has set these personal instructions — always follow them:\n${String(userPrompt).trim().slice(0, AI_BUDGETS.userPrompt)}`
          : "";

        const assistantIdentitySection = buildAssistantIdentitySection(aiName);

        const staticPersona = customModelCtx.customModel
          ? getCustomModelChatPersonaStatic()
          : LYKN_CHAT_PERSONA_STATIC;

        return [
          // Static persona — LYKN default or custom-model runtime (no "You are LYKN"
          // identity when a published custom model is active).
          staticPersona,

          // Dynamic per-call sections (everything below the first [MARKER] is
          // treated as 'user' content by splitPromptForProvider — uncached).
          assistantIdentitySection,
          userPromptSection,
          `[INTENT]\n${String(input?.intent || "ask").trim().toLowerCase() || "ask"}`,
          input?.projectId ? `[PROJECT_ID]\n${String(input.projectId)}` : "",
          responseLengthNote,
          focusedBricksNote,
          convo ? `[CONVERSATION — each line shows role, timestamp, and (for assistant) which model wrote it. Prior assistant lines are from other models, not you.]\n${convo}` : "",
          conversationMemory ? `[CONVERSATION_MEMORY — past exchanges from other projects/vault]\n${sanitizeStaleSurfaceLanguage(String(conversationMemory).slice(0, 6000))}` : "",
          wsCtx ? `[WORKSPACE_CONTEXT]\n${wsCtx}` : "",
          rawPrompt ? `[REQUEST_CONTEXT]\n${rawPrompt}` : "",
          kb ? `[WHAT_IM_ON]\n[PROJECT_KNOWLEDGE]\nProject knowledge for the active focus — connect the screen / topic here when it fits.\n${kb}` : "",
          contextText ? `[CONTEXT]\n${contextText}` : "",
          imageNote,
          `[LATEST_USER_MESSAGE]\n${latestUserMessage || "(empty)"}`,
        ]
          .filter(Boolean)
          .join("\n\n");
      };

      // If the caller wants structured actions, wrap the prompt so the model can return JSON actions.
      const wantsActions = Boolean(returnActions);
      let wantsActionsUserText = '';
      if (wantsActions) {
        const ctx = String(context || "").trim().slice(0, 14000);
        const userText = String(text || "").trim() || String(prompt || "").trim();
        wantsActionsUserText = userText;
        const userIntent = String(intent || "question").trim().toLowerCase();
        prompt = [
          "You are LYKN, the user's personal AI, embedded inside a block-based grid editor. You have FULL CONTROL over the grid — you can create, edit, move, resize, delete, and organize ANY block on the user's board.",
          "When helpful, you may request that the app creates blocks or moves/resizes existing blocks by returning actions.",
          "",
          "Return ONLY a valid JSON object (no markdown fences, no extra text before or after) shaped like:",
          '{ "assistant": "string", "follow_up_questions": ["string"], "actions": [ ... ] }',
          "",
          LYKN_VOICE_DIRECT,
          "",
          "ASSISTANT TEXT VOICE (applies to the 'assistant' field only):",
          "- The 'assistant' string is shown to the user as a chat message — it MUST follow the VOICE rule above. Default to I / you when describing what was done on the board.",
          "- 'I added a heading and a checklist for you.' — fine as-is.",
          "- 'Here's your task board.' — fine as-is.",
          "- 'I cleaned up your grid.' — fine as-is.",
          "- Avoid forcing 'our' / 'let's' onto things you did alone ('I added a checklist' is better than 'we added a checklist' when only you made the change).",
          "",
          "RESPONSE FORMAT — ABSOLUTE RULES:",
          "- Your ENTIRE response must be a single JSON object. Nothing else.",
          "- Blocks are created ONLY via the 'actions' array. NEVER write block-creation markup, pseudo-code, or placeholder syntax in the 'assistant' text.",
          "- NEVER output [CREATE_BLOCK:...], [BLOCK:...], ```json blocks describing blocks, <add_blocks>...</add_blocks>, <add_wires>...</add_wires>, <blocks>, <wires>, <connect_blocks>, or ANY other invented XML/HTML/markdown wrapper syntax in the assistant text. These do NOTHING — the app cannot parse them. The ONLY way to create blocks is through the top-level 'actions' array of this JSON response. To wire blocks, use the action `connect_blocks` with `fromId`/`toId` in the same actions array — NOT a separate <add_wires> tag.",
          "- The 'assistant' text is shown to the user as a chat message. It should be conversational — describe what you're doing, not HOW you're doing it internally.",
          "- Do NOT apologize for past mistakes or say 'let me try again' — just return the correct JSON with the right actions.",
          "- VALID JSON ONLY — every double quote `\"` that appears INSIDE a string value MUST be escaped as `\\\"`. Example for a `content` field that contains a quoted phrase: `\"content\":\"Text overlay: *\\\"Think clearly.\\\"*\"`. Forgetting these backslashes makes the entire response unparseable and nothing reaches the grid. Do the same for backslashes (`\\\\`) and newlines (`\\n`). When in doubt, prefer single quotes or curly quotes (' or “”) inside string values to avoid the escaping problem entirely.",
          "",
          "BLOCK PLACEMENT — CRITICAL:",
          "- When you create multiple blocks in one response, they are placed SEQUENTIALLY top-to-bottom in the order you list them in the actions array. The FIRST block appears near the user's viewport center, and each subsequent block appears directly below the previous one.",
          "- This means the ORDER of your actions array determines the visual layout. Put the most important/top-level block first (e.g., heading before body text, title before content).",
          "- Think about logical document flow: heading → subheading → body → list → supporting content.",
          "- You can optionally include 'x' and 'y' (world-pixel coordinates, multiples of 24) on any create action to place it at a specific position. If omitted, sequential auto-placement is used.",
          "",
          "FOCUSED BLOCKS — CRITICAL:",
          "- The grid context may include a [USER_FOCUS] section with blocks marked [FOCUSED]. This means the user has double-pressed / raised that brick.",
          "- When a block is [FOCUSED], the user's message refers to THAT specific block. 'This brick', 'this', 'it', 'edit this', 'change this', 'make this', 'update this' ALL refer to the focused block.",
          "- You MUST use the focused block's id as the blockId in any update/edit/color/move/delete action. Do NOT ask which block — the focused block IS the answer.",
          "- If the user asks to edit/rewrite/change the focused block, use update_text_block with blockId from the [FOCUSED] block and new content.",
          "- If no block is focused and the user says 'this', match by content/label/type from the grid context.",
          "",
          "INTENT — think about WHY:",
          "- Before creating blocks, think about what the user is trying to BUILD. Are they making a document? A dashboard? A brainstorm? A project plan?",
          "- Match the block types to their intent: a project plan might need a heading + task board + notes; a brainstorm might need several text bricks; a document needs a sheet.",
          "- Explain in the 'assistant' text what you're building and why, so the user understands the structure.",
          "",
          "Rules:",
          "- The assistant text should be helpful, natural, and direct — refer to yourself as 'I' and the user as 'you' (e.g. 'I added a heading and a checklist — open the second one when you\\'re ready'). Explain what blocks were created and why.",
          "- If the user is ideating or unclear, ask 2-4 follow-up questions in follow_up_questions (e.g. 'Where do you want to go next?'). Natural 'we' is fine sparingly when something is genuinely shared, but the default is 'I / you'.",
          "- If the user explicitly asks to create/make/add a paper/doc, you MUST include {\"type\":\"create_sheet\"}.",
          "- If the user asks for a table, comparison, chart, or structured data display, use {\"type\":\"create_table\"} with headers and rows — this creates a visual table on the grid.",
          "- Only use {\"type\":\"create_spreadsheet\"} when the user explicitly says 'spreadsheet' or needs formulas, data entry, or a large data grid (budget, tracker, etc.).",
          "- If the user explicitly asks to create/make/add a todo/checklist/list, you MUST include {\"type\":\"create_list\"} with listType AND items. ALWAYS populate the items array with real content — never create an empty list.",
          "- If the user asks to create a heading (h1/h2/h3), you MUST include {\"type\":\"create_heading\",\"level\":1,\"content\":\"...\"}.",
          "- If the user asks to create a text block/brick/card/sticky note, you MUST include {\"type\":\"create_text\",\"content\":\"...\"}.",
          "- If the user asks to create a quote or callout, you MUST include {\"type\":\"create_quote\",\"content\":\"...\"}.",
          "- If the user asks to create a toggle or collapsible section, you MUST include {\"type\":\"create_toggle\",\"content\":\"...\"}.",
          "- If the user asks to create a kanban/task board, you MUST include {\"type\":\"create_task_board\"} with columns.",
          "- If the user asks to create a code block, you MUST include {\"type\":\"create_code_block\"} with language and content.",
          "- If the user asks to create a design board/canvas, you MUST include {\"type\":\"create_design_board\"}.",
          "- If the user asks to create a media/image/video/embed block, you MUST include {\"type\":\"create_media\"} or the specific variant.",
          "- If the user asks to pull, embed, drop, add, or put a website/site/page/url/link onto the grid (e.g. 'pull this site in', 'embed this URL', 'add this link to the board', 'drop in this website'), you MUST include {\"type\":\"create_embed\",\"url\":\"https://...\"}. The URL is rendered as a live iframe. If the user explicitly says 'bookmark' or 'just the link' or wants a clickable card (not a live page), use {\"type\":\"create_link\",\"url\":\"https://...\"} instead. NEVER tell the user you can't put a website on the grid — you can.",
          "- You have FULL ABILITY to create ANY type of brick on the grid. NEVER tell the user you cannot create a block — just do it by including the right action.",
          "- If the user asks to move, rearrange, organize, align, group, spread out, or lay out blocks, you MUST include move_block, move_blocks, or organize_grid actions. NEVER just say you organized them — you must actually include the actions.",
          "- If the user asks to connect, wire, link, or relate blocks, you MUST include connect_blocks actions with the correct block IDs. If they ask to disconnect or unlink, include remove_connection or disconnect_blocks.",
          "- If the user asks to color, paint, highlight, theme, or style a brick's background or text, use color_block. You MUST use ONLY the predefined color palette values below — do NOT use arbitrary hex values.",
          "- If the user asks to organize, tidy, clean up, auto-layout, or sort the grid/board, you can use {\"type\":\"organize_grid\",\"strategy\":\"grid\"} to auto-arrange all blocks, OR use move_blocks for precise positioning.",
          "- If the user asks to delete, remove, clear, trash, or get rid of blocks, you MUST include delete_block actions with the correct block IDs from the grid context. Match blocks by their label/content/type to find the right IDs. If the user says 'delete everything' or 'clear the board', include ALL block IDs.",
          "- If the user asks to edit, update, change, modify, rewrite, or fix content in an existing block, you MUST include the appropriate update action (update_text_block, update_spreadsheet, or update_list) with the correct blockId from the grid context. Match blocks by their label/content/type.",
          "- If the user mentions the 'notes page', 'notes panel', 'notes', or 'note pad' and asks to write, edit, draft, add, or compose content there, use update_notes (to replace) or append_notes (to add to existing). The grid context includes [GRID NOTES — current content] showing what's already in the notes. Write well-structured content with headings, lists, and paragraphs as appropriate.",
          "- You can combine multiple action types in a single response (e.g., create a spreadsheet AND update a text block AND delete another block AND write in the notes).",
          "- CONVERSATION CONTEXT (CRITICAL): The [CONVERSATION HISTORY] section below contains recent chat messages including YOUR OWN previous responses. When the user says 'put that in the notes', 'write those in the notes page', 'add what you just wrote', etc., find the referenced content in the conversation history and include it VERBATIM in your update_notes or append_notes action. You MUST reproduce the actual content from the conversation — do NOT ask the user to repeat it or say you don't have it.",
          "- When the user asks to create, make, add, or build something on the grid, ALWAYS include the appropriate action(s). Be proactive — if their request implies blocks (e.g., 'help me plan a project'), create them (heading + task board + list).",
          "- If the user is just asking a question or chatting, return an empty actions array. But if they ask for ANY type of block or content on the grid, create it.",
          "",
          "Supported actions (allowlist):",
          "",
          "CREATE actions — brick types (you can create ANY of these when the user asks):",
          '- { "type": "create_sheet" } — blank paper/document',
          '- { "type": "create_sheet", "title": "My Paper", "content": "body text" } — paper with initial content',
          '- { "type": "create_table", "headers": ["Name","Role","Status"], "rows": [["Alice","Dev","Active"],["Bob","Design","Active"]] } — visual markdown table (use this for most tables). cols defaults to 3.',
          '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells": { "0,0": "Header" } } — data spreadsheet (use only when user needs formulas, large data entry, or says "spreadsheet")',
          '- { "type": "create_spreadsheet", "rows": 30, "cols": 20, "cells2d": [["A","B"],["1","2"]], "startRow": 0, "startCol": 0 } — data spreadsheet with 2D array',
          '- { "type": "create_list", "listType": "todo"|"bulleted"|"numbered", "items": ["item one","item two","item three"] } — list block. ALWAYS include items with actual content.',
          '- { "type": "create_design_board" } — freeform design canvas',
          '- { "type": "create_task_board", "title": "Board Name", "columns": [{"title":"To Do","cards":["task1"]},{"title":"In Progress","cards":[]},{"title":"Done","cards":[]}] } — kanban board',
          '- { "type": "create_code_block", "language": "python"|"javascript"|"typescript"|"sql"|etc, "content": "code here" } — code block',
          '- { "type": "create_heading", "level": 1|2|3, "content": "Heading text" } — heading brick (h1/h2/h3). You can also use "create_h1", "create_h2", "create_h3" as shortcuts.',
          '- { "type": "create_text", "content": "Any text content", "format": "rich"|"plain"|"markdown" } — generic text brick. Also accepts "create_brick", "create_text_block", "create_card", "create_sticky".',
          '- { "type": "create_quote", "content": "Quote or callout text" } — callout/quote brick (also "create_callout")',
          '- { "type": "create_toggle", "content": "Collapsible section content" } — toggle/collapsible brick',
          '- { "type": "create_media", "url": "https://...", "mode": "image"|"video"|"embed"|"link", "name": "file name" } — generic media brick (also "create_image_block", "create_video_block")',
          '- { "type": "create_embed", "url": "https://...", "name": "Site title" } — pull a WEBSITE onto the grid as a live iframe (renders the actual page). Use this when the user says "pull this site in", "embed this", "drop in this URL", "add this website to the board". Aliases: "create_website".',
          '- { "type": "create_link", "url": "https://...", "name": "Link title" } — bookmark-style card with the URL (clickable, no iframe). Use when the user wants a tappable link tile rather than a live embedded page. Aliases: "create_bookmark".',
          '- { "type": "create_youtube_block", "url": "https://youtube.com/watch?v=..." } — embedded YouTube video',
          '- { "type": "create_universal_block", "data": { "content": "text", "textVariant": "h1"|"h2"|"body", "listType": "none"|"bulleted"|"numbered"|"checklist"|"toggle", "brickColor": "<palette value>", "textColor": "<palette value>" } } — universal text brick (headings, lists, quotes, body text). Colors must use the predefined palette values from the COLOR / STYLE section.',
          "",
          "ORGANIZE / AUTO-LAYOUT actions:",
          '- { "type": "organize_grid", "strategy": "grid"|"column"|"vertical", "columns": 3 } — auto-arrange all blocks on the grid into a clean layout. Use this when the user asks to organize, tidy, clean up, or auto-layout the board. Strategy "grid" arranges in rows/columns (default), "column"/"vertical" stacks vertically.',
          "",
          "EDIT actions:",
          '- { "type": "update_text_block", "blockId": "<id>", "content": "new full text" } — replace ALL text content of a brick/sheet. ALWAYS include content when editing text.',
          '- { "type": "update_text_block", "blockId": "<id>", "append": "additional text" } — append text to end of a brick/sheet',
          '- { "type": "update_text_block", "blockId": "<id>", "content": "same or new text", "data": { "textVariant": "h1" } } — change brick style AND content. Always include content OR append — never send update_text_block with only data.',
          '- { "type": "update_spreadsheet", "blockId": "<id>", "cells": { "0,0": "new value", "1,2": "updated" } } — update specific cells in a spreadsheet',
          '- { "type": "update_spreadsheet", "blockId": "<id>", "cells2d": [["A","B"],["1","2"]], "startRow": 0, "startCol": 0 } — overwrite region of a spreadsheet',
          '- { "type": "update_list", "blockId": "<id>", "items": ["replaced item 1","replaced item 2"] } — replace all list items',
          '- { "type": "update_list", "blockId": "<id>", "append": ["new item 1","new item 2"] } — append items to a list',
          "",
          "MOVE / RESIZE actions:",
          '- { "type": "move_block", "blockId": "<id>", "x": <newX>, "y": <newY> } — move to absolute world-pixel coordinates (snapped to grid)',
          '- { "type": "move_block", "blockId": "<id>", "dx": <deltaX>, "dy": <deltaY> } — move by relative offset in pixels',
          '- { "type": "move_blocks", "moves": [{ "blockId": "<id>", "x": <x>, "y": <y> }, ...] } — batch-move multiple blocks',
          '- { "type": "resize_block", "blockId": "<id>", "width": <w>, "height": <h> } — resize (world pixels, snapped to grid)',
          "",
          "COLOR / STYLE actions:",
          '- { "type": "color_block", "blockId": "<id>", "brickColor": "<value>", "textColor": "<value>" } — set background and/or text color on a brick.',
          '- { "type": "color_block", "blockIds": ["<id1>","<id2>"], "brickColor": "<value>" } — color multiple bricks at once.',
          '- To remove a color (reset to default), set the value to "" or null.',
          "",
          "ALLOWED BRICK BACKGROUND COLORS (brickColor) — use these EXACT values:",
          '  Default (clear) → ""',
          '  Blue    → "rgba(59,130,246,0.18)"',
          '  Green   → "rgba(22,163,74,0.18)"',
          '  Amber   → "rgba(217,119,6,0.18)"',
          '  Red     → "rgba(220,38,38,0.18)"',
          '  Purple  → "rgba(124,58,237,0.18)"',
          '  Pink    → "rgba(219,39,119,0.18)"',
          '  Teal    → "rgba(15,118,110,0.18)"',
          "",
          "ALLOWED TEXT COLORS (textColor) — use these EXACT values:",
          '  Default → ""',
          '  Blue    → "#3B82F6"',
          '  Green   → "#16A34A"',
          '  Amber   → "#D97706"',
          '  Red     → "#DC2626"',
          '  Purple  → "#7C3AED"',
          '  Pink    → "#DB2777"',
          '  Teal    → "#0F766E"',
          "",
          "When the user says a color name, map it to the closest palette value above. For example: 'red' → Red, 'yellow'/'gold' → Amber, 'cyan'/'turquoise' → Teal, 'violet'/'lavender' → Purple, 'magenta'/'rose' → Pink. NEVER use colors outside these palettes.",
          "",
          "CONNECTION / WIRE actions:",
          '- { "type": "connect_blocks", "fromId": "<id>", "toId": "<id>", "fromSide": "<side>", "toSide": "<side>" } — draw a wire connecting two blocks. Sides: "top", "right", "bottom", "left".',
          '- { "type": "remove_connection", "fromId": "<id>", "toId": "<id>" } — remove the wire between two blocks',
          '- { "type": "disconnect_blocks", "fromId": "<id>" } — remove ALL wires connected to a block',
          "",
          "WIRE SIDE SELECTION — choose sides based on the spatial positions of the blocks (use x, y, w, h from the grid context):",
          "- If block B is to the RIGHT of block A → fromSide='right', toSide='left'",
          "- If block B is to the LEFT of block A → fromSide='left', toSide='right'",
          "- If block B is BELOW block A → fromSide='bottom', toSide='top'",
          "- If block B is ABOVE block A → fromSide='top', toSide='bottom'",
          "- If block B is diagonally down-right → fromSide='right', toSide='left' (or 'bottom'/'top' if mostly vertical)",
          "- Use the block center positions to decide: centerX = x + w/2, centerY = y + h/2. Compare the horizontal vs vertical distance between centers — use the axis with the LARGER distance to pick sides.",
          "- Do NOT always default to top→bottom. Use the actual layout to pick the most natural direction for the wire.",
          "- If you omit fromSide/toSide, the system will auto-compute them from block positions — but it's better to specify them yourself for clarity.",
          "",
          "DELETE actions:",
          '- { "type": "delete_block", "blockId": "<id>" } — delete a single block',
          '- { "type": "delete_block", "blockIds": ["<id1>", "<id2>", ...] } — delete multiple blocks',
          "",
          "NOTES actions (for the grid's Notes page/panel):",
          '- { "type": "update_notes", "content": "Full replacement text with\\nline breaks" } — replace ALL notes content',
          '- { "type": "append_notes", "content": "Text to add at the end" } — append to existing notes',
          "  Notes content supports plain text with markdown-like formatting: # Heading 1, ## Heading 2, ### Heading 3, - bullet items, 1. numbered items.",
          "",
          "Move/resize rules:",
          "- The grid context below includes EVERY block's id, x, y, w, h in world pixels. Use those values to calculate new positions.",
          "- Grid cell size is 24px. All positions MUST be multiples of 24 for clean alignment.",
          "- To move a block to the right by ~200px, use dx: 192 (8 grid cells × 24). To move down ~100px, use dy: 96 (4 cells × 24).",
          "- When the user says 'move X to the right/left/up/down', use relative dx/dy. When they say 'put X next to Y', compute absolute x/y from Y's position.",
          "- You can combine move_block with other actions in the same response.",
          "",
          "ORGANIZING / ARRANGING blocks:",
          "- When the user asks to 'organize', 'arrange', 'clean up', 'lay out', or 'sort' blocks, you MUST generate move_blocks actions with calculated coordinates for EVERY block that needs to move.",
          "- Read all blocks from the grid context, decide on a logical layout (e.g., group by type, arrange in rows/columns, cluster related items), and compute absolute x/y positions for each block.",
          "- Use the blocks' current w (width) and h (height) to space them properly. Leave a gap of 24-48px between blocks.",
          "- **VIEWPORT CENTERING (CRITICAL)**: The grid context includes 'Viewport center: x=NNN y=NNN' and optionally 'Viewport size: WxH'. This is where the user is currently looking. You MUST center your layout around the viewport center, NOT around (0,0). Calculate the total layout bounding box first, then offset all positions so the layout's center aligns with the viewport center. For example, if the viewport center is x=2000 y=1500 and your layout is 1200px wide and 900px tall, start placing blocks at x=(2000-600)=1400 y=(1500-450)=1050.",
          "- Common layout patterns:",
          "  • Grid layout: arrange blocks in rows and columns, wrapping to the next row when a row gets too wide (e.g., 1200px). Center the grid around viewport center.",
          "  • Grouped layout: cluster related blocks together (e.g., all images in one area, all text in another), with group labels implied by spacing.",
          "  • Horizontal row: place blocks side by side with consistent gaps, centered on viewport center.",
          "  • Vertical column: stack blocks top to bottom, centered horizontally on viewport center x.",
          "- ALWAYS use move_blocks (batch) when moving 2+ blocks. Include ALL blocks that need repositioning.",
          "- Use each block's actual id from the grid context. Do NOT invent block IDs.",
          "",
          "EDITING / UPDATING blocks (CRITICAL):",
          "- When the user asks to edit, change, update, rewrite, rename, fix, or modify a block, you MUST include an update action with the correct blockId. NEVER just describe the change — always include the action.",
          "- **CONTENT IS REQUIRED**: When editing/rewriting text, you MUST include 'content' with the FULL new text for the block. An update_text_block without 'content' does NOTHING useful — it will be rejected. Always provide the complete replacement text, not just the blockId.",
          "- **FOCUSED BLOCKS**: If the grid context includes [USER_FOCUS] with a [FOCUSED] block, that is the block the user is referring to when they say 'this brick', 'this block', 'it', 'this', 'edit this', etc. Use its blockId for the update action.",
          "- For text bricks and sheets: use update_text_block with 'content' (full replacement text) or 'append' (text to add). Use 'data' to change style: {\"textVariant\":\"h1\"|\"h2\"|\"body\", \"listType\":\"none\"|\"bullet\"|\"numbered\"|\"todo\"|\"toggle\"|\"quote\", \"brickColor\":\"<palette value>\", \"textColor\":\"<palette value>\"}. Colors must use the predefined palette values from the COLOR / STYLE section.",
          "- For spreadsheets: use update_spreadsheet with 'cells' (key-value map like '0,0':'value') or 'cells2d' (2D array) to update cells.",
          "- For lists: use update_list with 'items' to replace all items, or 'append' to add new items to the end.",
          "- For code blocks: use update_code_block with 'content' and optional 'language'.",
          "- You can combine edits with creates, moves, deletes, and connections in one response.",
          "",
          "CONNECTIONS / WIRES:",
          "- When the user asks to connect, wire, link, or relate blocks, use connect_blocks with the block IDs from the grid context.",
          "- ALWAYS look at block positions (x, y, w, h) to determine the best fromSide and toSide. Wires should feel natural — use horizontal sides (right/left) for blocks that are side-by-side, vertical sides (bottom/top) for blocks stacked above/below, and diagonal combinations (e.g. right→top, bottom→left) when blocks are offset.",
          "- The grid context [CONNECTIONS] section shows existing wires. Don't create duplicates.",
          "- When building flowcharts, diagrams, or process maps, create the blocks AND the connections in the same response.",
          "- To disconnect, use remove_connection with fromId+toId, or disconnect_blocks with fromId to clear all wires from a block.",
          "",
          "Examples:",
          '- If user says "I need to write a paper", include actions: [{"type":"create_sheet"}].',
          '- If user says "make a table comparing features", include actions: [{"type":"create_table","headers":["Feature","Plan A","Plan B"],"rows":[["Price","$10","$20"],["Storage","5GB","50GB"]]}].',
          '- If user says "make me a budget spreadsheet", include actions: [{"type":"create_spreadsheet","rows":30,"cols":6}].',
          '- If user says "I need a todo list", include actions: [{"type":"create_list","listType":"todo","items":["First task","Second task","Third task"]}].',
          '- If user says "make a grocery list", include actions: [{"type":"create_list","listType":"bulleted","items":["Milk","Eggs","Bread"]}].',
          '- If user says "move that text block to the right", include actions: [{"type":"move_block","blockId":"<the block id>","dx":240,"dy":0}].',
          '- If user says "put X next to Y", read Y\'s x+w to compute X\'s new x, and use Y\'s y for the same row.',
          '- If user says "make it bigger", include actions: [{"type":"resize_block","blockId":"<id>","width":<newW>,"height":<newH>}].',
          '- If user says "delete that image" or "remove the budget spreadsheet", find the matching block ID and include actions: [{"type":"delete_block","blockId":"<the block id>"}].',
          '- If user says "delete everything" or "clear the board", include actions: [{"type":"delete_block","blockIds":["<id1>","<id2>","<id3>",...]}] with ALL block IDs from the grid context.',
          '- If user says "change the heading to say Project Plan", find the heading block and include actions: [{"type":"update_text_block","blockId":"<id>","content":"Project Plan"}].',
          '- If user says "add a row to my spreadsheet with Q2 data", include actions: [{"type":"update_spreadsheet","blockId":"<id>","cells":{"5,0":"Q2","5,1":"1500","5,2":"2300"}}].',
          '- If user says "add milk and eggs to my grocery list", include actions: [{"type":"update_list","blockId":"<id>","append":["milk","eggs"]}].',
          '- If user says "rewrite my todo list", include actions: [{"type":"update_list","blockId":"<id>","items":["new item 1","new item 2"]}].',
          '- If user says "connect the heading to the list", find both block IDs and include actions: [{"type":"connect_blocks","fromId":"<heading-id>","toId":"<list-id>","fromSide":"bottom","toSide":"top"}].',
          '- If user says "make a flowchart with 3 steps", create blocks AND wires: actions: [{"type":"create_text","content":"Step 1"},{"type":"create_text","content":"Step 2"},{"type":"create_text","content":"Step 3"}] — then after blocks are created, the user can ask to connect them.',
          '- If user says "disconnect everything from the heading", include actions: [{"type":"disconnect_blocks","fromId":"<heading-id>"}].',
          '- If user says "make the heading red", find the heading block and include actions: [{"type":"color_block","blockId":"<id>","textColor":"#DC2626"}].',
          '- If user says "give this brick a blue background", include actions: [{"type":"color_block","blockId":"<id>","brickColor":"rgba(59,130,246,0.18)"}].',
          '- If user says "color all the bricks green", include actions: [{"type":"color_block","blockIds":["<id1>","<id2>",...],"brickColor":"rgba(22,163,74,0.18)"}].',
          '- If user says "reset the colors", include actions: [{"type":"color_block","blockId":"<id>","brickColor":"","textColor":""}].',
          '- If user says "make a kanban for my project", include actions: [{"type":"create_task_board","title":"Project Board","columns":[{"title":"To Do","cards":["Research","Design"]},{"title":"In Progress","cards":[]},{"title":"Done","cards":[]}]}].',
          '- If user says "add a Python code block", include actions: [{"type":"create_code_block","language":"python","content":"# Your code here\\n"}].',
          '- If user says "create a heading that says Welcome", include actions: [{"type":"create_heading","level":1,"content":"Welcome"}].',
          '- If user says "add a subheading", include actions: [{"type":"create_heading","level":2,"content":"Subheading"}].',
          '- If user says "make a text block with my bio", include actions: [{"type":"create_text","content":"Your bio text here..."}].',
          '- If user says "add a quote block", include actions: [{"type":"create_quote","content":"The quote text here"}].',
          '- If user says "create a toggle section", include actions: [{"type":"create_toggle","content":"Collapsible content here"}].',
          '- If user says "add a task board for my sprint", include actions: [{"type":"create_task_board","title":"Sprint Board","columns":[{"title":"Backlog","cards":["Task 1"]},{"title":"In Progress","cards":[]},{"title":"Done","cards":[]}]}].',
          '- If user says "create a design board", include actions: [{"type":"create_design_board"}].',
          '- If user says "pull this site in: https://example.com" or "embed https://example.com" or "drop google.com onto the grid" or "add this website https://wikipedia.org" — include actions: [{"type":"create_embed","url":"https://example.com"}]. ALWAYS extract the URL from the user message verbatim. If the user wrote a bare domain (e.g. "google.com" or "nytimes.com"), use it as-is — the app will add https:// automatically. NEVER ask the user for the URL again — it is in their message.',
          '- If user says "bookmark https://example.com" or "save this link" or "add a link tile for https://docs.foo.com" — include actions: [{"type":"create_link","url":"https://docs.foo.com","name":"Foo Docs"}].',
          '- If user says "tidy up my board" or "organize the grid", include actions: [{"type":"organize_grid","strategy":"grid"}].',
          '- If user says "help me plan a project", create a structured set: actions: [{"type":"create_heading","level":1,"content":"Project Plan"},{"type":"create_text","content":"Overview and goals..."},{"type":"create_task_board","title":"Project Tasks","columns":[{"title":"To Do","cards":["Research","Design","Build"]},{"title":"In Progress","cards":[]},{"title":"Done","cards":[]}]}]. These will appear stacked top-to-bottom in this order.',
          '- If user says "create a notes section", create: [{"type":"create_heading","level":1,"content":"Notes"},{"type":"create_text","content":""}]. The heading appears on top, the text block below it.',
          '- If user says "write a project summary in the notes page", include actions: [{"type":"update_notes","content":"# Project Summary\\n\\nThis project aims to...\\n\\n## Key Goals\\n\\n- Goal 1\\n- Goal 2"}].',
          '- If user says "add meeting notes to the notes page", include actions: [{"type":"append_notes","content":"\\n## Meeting Notes — Today\\n\\n- Discussed timeline\\n- Agreed on milestones"}].',
          '- If user says "clear the notes page" or "rewrite the notes", use update_notes with the new or empty content.',
          '- If user previously asked for a list and then says "write those in the notes page", find that list in [CONVERSATION HISTORY] and include it in actions: [{"type":"update_notes","content":"# Names\\n\\n- Alice\\n- Bob\\n- Charlie"}] (using the ACTUAL content from conversation).',
          '- If user says "organize everything" and viewport center is x=2000 y=1500, compute a clean grid centered there:',
          '  actions: [{"type":"move_blocks","moves":[{"blockId":"abc","x":1400,"y":1050},{"blockId":"def","x":1688,"y":1050},{"blockId":"ghi","x":1400,"y":1386},...]}]',
          "",
          "If the user mentions writing a paper/essay/report/document, prefer {\"type\":\"create_sheet\"}.",
          "If the user mentions a table/comparison/chart, prefer {\"type\":\"create_table\"}. Only use create_spreadsheet when they say 'spreadsheet' or need formulas/data entry.",
          "",
          ctx ? `Grid context (use these block IDs and positions):\n${ctx}\n` : "",
          conversationMemory ? `[CONVERSATION MEMORY]\n${String(conversationMemory).slice(0, 2000)}` : "",
          (() => {
            const msgs = Array.isArray(conversation) ? conversation : [];
            if (!msgs.length) return "";
            const lines = msgs
              .slice(-14)
              .map((m) => {
                const role = String(m?.role || "user");
                const limit = role === "assistant" ? 5000 : 1500;
                const body = String(m?.content || "").slice(0, limit);
                if (role === "system") return `[System]: ${body}`;
                return role === "assistant" ? `Assistant: ${body}` : `User: ${body}`;
              })
              .join("\n");
            return `[CONVERSATION HISTORY — recent messages. When the user says "those", "that", "what you wrote", etc., the content they mean is here. You MUST use this content in your actions.]\n${lines}`;
          })(),
          `Intent: ${userIntent}`,
          "",
          `User text:\n${userText}`,
        ]
          .filter(Boolean)
          .join("\n");
      }

      const normalizedIntent = String(intent || "").trim().toLowerCase();
      const isChatIntent = normalizedIntent === "ask" || normalizedIntent === "chat" || normalizedIntent === "question";
      if (!wantsActions && isChatIntent) {
        prompt = buildLyknChatPrompt({
          prompt,
          text,
          context,
          knowledgeBase: kbText,
          workspaceContext,
          projectId,
          conversation,
          intent: normalizedIntent || "ask",
        });
      }

      // Auto-classify enrichment tier based on query content
      const userText = String(text || prompt || "");
      // Pull out the user's actual latest message (strips conversation prefix
      // and "Latest user message:\n" delimiter so heuristics see only what the
      // user typed in this turn).
      const pureUserMessage = extractPureUserMessage(text, prompt);
      const searchText = pureUserMessage || userText;
      const hasContextForSearch = Boolean(context) || Boolean(knowledgeBase) || Boolean(workspaceContext);
      const enrichTier = (wantsActions || !isChatIntent)
        ? 'none'
        : classifyEnrichment(pureUserMessage || text, { hasFocusedBricks: Boolean(hasFocusedBricks), hasContext: hasContextForSearch, conversation });
      if (enrichTier === 'none') console.log('⚡ No enrichment needed — simple query / action');
      else if (enrichTier === 'light') console.log('💡 Light enrichment — synthesis + user model (no web)');
      else console.log('🔬 Full enrichment — synthesis, user model, web search, URL scraping');
      // Explicit URL intent overrides the tier — if the user pasted a URL and
      // asked us to read / browse / search it, we scrape regardless of tier.
      const explicitUrlIntent = !wantsActions && hasExplicitUrlScrapeIntent(searchText);
      if (explicitUrlIntent) console.log('🔗 Explicit URL scrape intent detected — forcing scrape');
      // Pasted-URL auto-scrape: ANY URL in the current user message triggers a
      // scrape, regardless of enrichment tier. Without this, a bare paste like
      // "https://example.com what do you think?" silently got dropped because
      // it had no intent verbs/nouns and the classifier didn't rate it 'full'.
      // The internal gating in scrapeUrlsFromText (max 3 URLs without force,
      // 800-char message cap without force) bounds the cost. Explicit-intent
      // turns still set force:true below, which lifts those caps to 5 / no
      // length gate. wantsActions stays out — the action-JSON path doesn't
      // route web content into the model.
      const hasUrlInMessage = !wantsActions && URL_DETECT_RE.test(searchText);
      if (hasUrlInMessage && !explicitUrlIntent) console.log('🔗 Pasted URL detected — auto-scraping (no explicit intent verbs)');
      const skipScrape    = !explicitUrlIntent && !hasUrlInMessage;
      const skipSearch    = (forceWebSearch || deepResearch) ? false : (skipWebSearch || enrichTier !== 'full');
      const slimIdentity = isChatIntent && enrichTier === 'none';
      const skipPersonalMemory = !isChatIntent;
      const skipYouTube   = enrichTier === 'none' || !needsYouTubeSearch(pureUserMessage || searchText);
      // Projects are opt-in (same gate as /stream): scoped/bound or explicit ask.
      const invokeInProject = Boolean(
        readCustomModelLinkedProjectId(customModelCtx.customModel) ||
        String(projectId || '').trim(),
      );
      const invokeWantsProject = messageWantsProjectContext(pureUserMessage || searchText);
      const skipProject = !invokeInProject && !invokeWantsProject;
      const vaultUrlMatchesPromise = Promise.resolve('');
      const customModelKnowledgePromise =
        customModelCtx.customModel && req.user?.id
          ? fetchCustomModelKnowledgeSection(req.user.id, customModelCtx.customModel)
          : Promise.resolve('');
      const invokeSearchPromise = skipSearch
        ? Promise.resolve('')
        : deepResearch
          ? (async () => {
              const topic = String(pureUserMessage || searchText || '').trim();
              if (!topic || topic.length < 4 || messageIsPureGreeting(topic)) return '';
              console.log(
                `🔬 Deep research (invoke): "${topic.slice(0, 80)}" (sources=${researchSourcePref || 'all'})`,
              );
              const out = await runDeepResearchForPrompt(topic, {
                sourcePref: researchSourcePref,
              });
              if (out.ok && out.text) {
                console.log(
                  `✅ Deep research (invoke): ${out.pack?.queries?.length || 0} queries, ` +
                    `${out.pack?.pages?.length || 0} pages`,
                );
                return out.text;
              }
              console.warn(`⚠️ Deep research (invoke) failed (${out.pack?.error || 'unknown'}) — fallback web search`);
              return runWebSearchIfNeeded(topic, {
                hasFocusedBricks: Boolean(hasFocusedBricks),
                hasContext: hasContextForSearch,
                conversation,
                force: true,
                deep: true,
              });
            })()
          : runWebSearchIfNeeded(searchText, {
              hasFocusedBricks: Boolean(hasFocusedBricks),
              hasContext: hasContextForSearch,
              conversation,
              force: forceWebSearch,
              deep: false,
            });
      const [scrapedContent, searchResults, youtubeResults, vaultUrlMatches, connectedToolsSection, projectSection, customModelKnowledge] = await Promise.all([
        skipScrape ? Promise.resolve("") : scrapeUrlsFromText(searchText, { force: explicitUrlIntent }),
        invokeSearchPromise,
        skipYouTube ? Promise.resolve("") : runYouTubeSearchIfNeeded(pureUserMessage || searchText),
        vaultUrlMatchesPromise,
        Promise.resolve(""),
        // Active synthesis-layer project — slim on casual turns, full on light/full.
        !skipProject
          ? fetchProjectSection(
              req.headers.authorization,
              req.user?.id,
              readCustomModelLinkedProjectId(customModelCtx.customModel),
              { slim: slimIdentity },
            )
          : Promise.resolve({ text: '', projectId: null, neuronIds: [] }),
        customModelKnowledgePromise,
      ]);
      // Markdown Memory is the sole personal-memory context.
      const invokeMsg = pureUserMessage || searchText || "";
      const wantsPureGreeting = messageIsPureGreeting(invokeMsg);
      const userRecallMode = wantsPureGreeting
        ? null
        : resolveUserRecallMode(invokeMsg, conversation);
      const wantsUserRecall = userRecallMode != null;
      const wantsUserRecallDeepen = userRecallMode === 'deepen';
      let memorySection = "";
      // Pure greetings: skip personal memory so the model doesn't invent a brief.
      if (!skipPersonalMemory && !wantsPureGreeting) {
        const memoryTurn = await resolveProductionChatMemory({
          userId: req.user?.id,
          user: req.user,
          chatId: req.body?.chatId,
          recall: wantsUserRecall,
          deepen: wantsUserRecallDeepen,
        });
        memorySection = memoryTurn.text || "";
      }
      if (connectedToolsSection && !wantsPureGreeting) prompt += "\n\n" + connectedToolsSection;
      if (customModelCtx.overlay?.beliefText) {
        prompt += "\n\n" + sanitizeStaleSurfaceLanguage(customModelCtx.overlay.beliefText);
      }
      // User-recall / greetings: keep projects out of the prompt.
      if (projectSection?.text && !wantsUserRecall && !wantsPureGreeting) {
        prompt += "\n\n" + sanitizeStaleSurfaceLanguage(projectSection.text);
      }
      if (memorySection) prompt += "\n\n" + sanitizeStaleSurfaceLanguage(memorySection);
      if (wantsPureGreeting) prompt += "\n\n" + GREETING_TURN_PROMPT;
      else if (wantsUserRecallDeepen) prompt += "\n\n" + USER_RECALL_DEEPEN_PROMPT;
      else if (wantsUserRecall) prompt += "\n\n" + USER_RECALL_TURN_PROMPT;
      if (customModelKnowledge) prompt += "\n\n" + sanitizeStaleSurfaceLanguage(customModelKnowledge);
      if (vaultUrlMatches) prompt += "\n\n" + vaultUrlMatches;
      if (scrapedContent) prompt += "\n\n" + scrapedContent;
      if (searchResults) prompt += "\n\n" + searchResults;
      if (youtubeResults) prompt += "\n\n" + youtubeResults;
      if (deepResearch) {
        const evidence = String(searchResults || '');
        if (evidence.includes('[DEEP_RESEARCH_EVIDENCE]')) {
          prompt +=
            '\n\n[RESEARCH_MODE — Deep research is armed. Treat [DEEP_RESEARCH_EVIDENCE] as your primary evidence and follow [RESEARCH_REPORT_INSTRUCTIONS]. ' +
            'Deliver as markdown in your reply ONLY — do not call lykn_build_* or create a side-panel artifact.]';
        } else if (evidence.includes('[WEB_SEARCH_RESULTS]')) {
          prompt +=
            '\n\n[RESEARCH_MODE — Deep research is armed. Multi-query research was unavailable, so use [WEB_SEARCH_RESULTS] as your evidence. ' +
            'Write a thorough markdown report and end with a **Sources** section listing markdown links ONLY from those results — never invent URLs. ' +
            'Do not call lykn_build_* or create a side-panel artifact.]';
        } else {
          prompt +=
            '\n\n[RESEARCH_MODE — Deep research was requested but live multi-source evidence was unavailable. ' +
            'Say so briefly, answer carefully from general knowledge with clear uncertainty, and do not invent URLs or a fake Sources list. ' +
            'Do not fall back to building an interactive artifact.]';
        }
      }
      if (customModelCtx.overlay) {
        prompt = applyCustomModelOverlayToPrompt(prompt, customModelCtx.overlay);
      }

      // Handle unified-auto mode — prefer Gemini Flash (cheapest by far),
      // and if no Google key is configured fall back to gpt-4.1-nano. The
      // legacy gpt-4o / gpt-3.5-turbo fallbacks were ~25× and ~2× more
      // expensive respectively for the exact same chat workload, so this
      // is a pure cost win for the rare case Google goes down or the key
      // is missing.
      let actualModel = model;
      if (model === 'unified-auto') {
        if (process.env.GOOGLE_API_KEY) {
          actualModel = 'gemini-flash-latest';
          console.log(`🔄 Unified mode: using ${actualModel} (free tier)`);
        } else if (process.env.OPENAI_API_KEY) {
          actualModel = 'gpt-4.1-nano';
          console.log(`🔄 Unified mode: using ${actualModel} (cheap fallback)`);
        } else {
          actualModel = 'gpt-4.1-nano';
          console.log(`🔄 Unified mode: using ${actualModel} (last-resort fallback)`);
        }
      } else if (LYKN_ROUTED_MODELS[model]) {
        actualModel = resolveLyknAlias(model);
        console.log(`🟣 LYKN alias (${model}) → ${actualModel}`);
      }

      // Skip sending images when AI only needs to compute block positions (organize/move/resize)
      const effectiveImageUrls = wantsActions ? [] : imageUrls;
      // Image turns on a weak-vision model get bumped to a stronger reader so
      // text inside the image is actually legible (no-op for text-only turns).
      actualModel = upgradeModelForVision(actualModel, effectiveImageUrls.length > 0);
      if (wantsActions && imageUrls.length > 0) {
        console.log(`⚡ Skipping ${imageUrls.length} image(s) for action-only request (faster)`);
      } else if (effectiveImageUrls.length > 0) {
        console.log(`🖼️ Sending ${effectiveImageUrls.length} image(s) to ${actualModel}`);
      }

      let responseText = '';
      let usageData = { input_tokens: 0, output_tokens: 0 };
      const chatId = req.body?.chatId || null;

      // ── Provider fallback: retry with another provider on rate-limit / overload ──
      const _invokeModels = buildProviderModelChain(
        actualModel,
        customModelCtx.overlay,
        getFallbackModels,
      );
      for (let _ii = 0; _ii < _invokeModels.length; _ii++) {
        if (_ii > 0) { actualModel = _invokeModels[_ii]; console.log(`🔄 Invoke fallback → ${actualModel} (attempt ${_ii + 1}/${_invokeModels.length})`); }
        try {

      if (isTogetherModel(actualModel)) {
        if (!process.env.TOGETHER_API_KEY) {
          return res.status(503).json({
            error: 'Together API key not configured. Set TOGETHER_API_KEY for LoRA inference.',
          });
        }
        const { system: tSys, user: tUser } = splitPromptForProvider(prompt);
        const invokeUserText = String(text || '').trim();
        const tMessages = customModelCtx.overlay?.useTogetherMultiTurn
          ? buildTogetherLoraMessages({
              system: tSys,
              conversation,
              latestUserText: invokeUserText,
              supplementalContext: extractSupplementalUserContext(tUser, invokeUserText),
              includeTurnRules: false,
            })
          : (() => {
              const m = [];
              if (tSys) m.push({ role: 'system', content: tSys });
              m.push({ role: 'user', content: tUser });
              return m;
            })();
        const _tCap = clampForProvider(pickOutputCap({
          wantsActions,
          hasImages: effectiveImageUrls.length > 0,
        }), actualModel);
        const invokeAttachLora =
          customModelCtx.overlay?.loraActive &&
          (customModelCtx.overlay?.loraServerlessHostCandidates || []).includes(actualModel);
        const tRes = await fetch('https://api.together.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(
            buildTogetherChatBody({
              model: actualModel,
              messages: tMessages,
              max_tokens: _tCap,
              overlay: customModelCtx.overlay,
              chatParams: invokeAttachLora ? customModelCtx.overlay?.togetherChatParams : undefined,
            }),
          ),
        });
        if (!tRes.ok) {
          const err = await tRes.json().catch(() => ({}));
          throw new Error(`Together: ${err?.error?.message || tRes.statusText}`);
        }
        const tData = await tRes.json();
        responseText = tData?.choices?.[0]?.message?.content || '';
        usageData = {
          input_tokens: tData?.usage?.prompt_tokens || 0,
          output_tokens: tData?.usage?.completion_tokens || 0,
        };

      } else if (isOpenAIModel(actualModel)) {
        if (!process.env.OPENAI_API_KEY) {
          console.error('❌ OPENAI_API_KEY not found in environment variables');
          return res.status(500).json({ 
            error: 'OpenAI API key not configured. Please set OPENAI_API_KEY in your .env file.' 
          });
        }
        const openAIResult = await invokeOpenAIModel(actualModel, prompt, effectiveImageUrls, {
          userId: req.user?.id,
          wantsActions,
          // No intent passed: classifyActionType pre-generation always returns
          // 'chat_short' (2500 cap) because responseLength is 0, which silently
          // capped real chat replies at ~1700 words and made MAX_TOKENS the
          // most common stream finishReason. pickOutputCap falls through to
          // OUTPUT_CAPS.chat (6000) when no intent is provided, which is
          // what we actually want for chat streaming. wantsActions and
          // hasImages still pick the right caps via the early-returns inside
          // pickOutputCap.
        });
        responseText = openAIResult.text;
        usageData = openAIResult.usage;

      } else if (actualModel.includes('claude')) {
        if (!process.env.ANTHROPIC_API_KEY) {
          console.error('❌ ANTHROPIC_API_KEY not found in environment variables');
          return res.status(500).json({ 
            error: 'Anthropic API key not configured. Please set ANTHROPIC_API_KEY in your .env file.' 
          });
        }

        const anthropicModel = resolveAnthropicModel(actualModel);
        if (anthropicModel !== actualModel) {
          console.log(`🔁 Anthropic model alias: ${actualModel} -> ${anthropicModel}`);
        }

        const { system: claudeSys, user: claudeUser } = splitPromptForProvider(prompt);
        const anthropicContent = [];
        anthropicContent.push({ type: 'text', text: claudeUser });
        for (const url of effectiveImageUrls) {
          try {
            if (url.startsWith('data:image/')) {
              const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
              if (match) {
                anthropicContent.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
              }
            } else if (url.startsWith('http')) {
              const imgRes = await safeFetch(url);
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
                const mediaType = contentType.split(';')[0].trim();
                anthropicContent.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') } });
              }
            }
          } catch (imgErr) {
            console.warn('⚠️ Failed to fetch image for Claude:', imgErr?.message || imgErr);
          }
        }

        const _claudeCap = clampForProvider(pickOutputCap({
          wantsActions,
          hasImages: effectiveImageUrls.length > 0,
          // See note at the OpenAI invoke call: skipping `intent` lets
          // pickOutputCap use OUTPUT_CAPS.chat instead of the broken
          // pre-generation 'chat_short' classification (2500).
        }), anthropicModel);
        const anthropicBody = {
          model: anthropicModel,
          messages: [{ role: 'user', content: effectiveImageUrls.length > 0 ? anthropicContent : claudeUser }],
          max_tokens: _claudeCap,
        };
        if (claudeSys) {
          anthropicBody.system = [{ type: 'text', text: claudeSys, cache_control: { type: 'ephemeral' } }];
        }
        const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'prompt-caching-2024-07-31',
            'content-type': 'application/json'
          },
          body: JSON.stringify(anthropicBody)
        });

        if (!anthropicRes.ok) {
          const errorData = await anthropicRes.json().catch(() => ({}));
          console.error('❌ Anthropic API Error:', errorData);
          throw new Error(`Anthropic: ${errorData.error?.message || anthropicRes.statusText}`);
        }
        const data = await anthropicRes.json();
        responseText = data.content?.[0]?.text?.trim() || '';
        usageData = extractAnthropicUsage(data);

      } else if (actualModel.startsWith('gemini-') || actualModel.includes('gemini')) {
        // Google Gemini
        if (!process.env.GOOGLE_API_KEY) {
          console.error('❌ GOOGLE_API_KEY not found in environment variables');
          return res.status(500).json({ 
            error: 'Google API key not configured. Please set GOOGLE_API_KEY in your .env file.' 
          });
        }

        // Map model names to Gemini API model IDs
        // Available models: gemini-2.5-flash, gemini-2.0-flash, gemini-flash-latest, gemini-2.5-pro, etc.
        let geminiModel = actualModel;
        if (actualModel === 'gemini-pro' || actualModel === 'gemini-1.5-flash') {
          geminiModel = 'gemini-flash-latest';
          console.log(`⚠️ ${actualModel} is deprecated, using gemini-flash-latest instead`);
        } else if (actualModel === 'gemini-1.5-pro') {
          geminiModel = 'gemini-pro-latest';
          console.log('⚠️ gemini-1.5-pro is deprecated, using gemini-pro-latest instead');
        } else if (actualModel === 'gemini-3-pro-preview') {
          geminiModel = 'gemini-3.1-pro-preview';
          console.log('⚠️ gemini-3-pro-preview shut down, using gemini-3.1-pro-preview instead');
        } else if (actualModel.startsWith('gemini-') || actualModel.includes('gemini')) {
          geminiModel = actualModel;
        } else {
          geminiModel = 'gemini-flash-latest';
        }

        console.log(`🔮 Calling Gemini API with model: ${geminiModel}`);
        console.log(`   API Key: ${process.env.GOOGLE_API_KEY ? 'SET (' + process.env.GOOGLE_API_KEY.substring(0, 10) + '...)' : 'NOT SET'}`);
        
        // Try v1beta first (free tier compatible), then fallback to v1 if needed
        const { system: gemSys, user: gemUser } = splitPromptForProvider(prompt);
        const geminiParts = [{ text: gemUser }];
        for (const url of effectiveImageUrls) {
          try {
            if (url.startsWith('data:image/')) {
              const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
              if (match) {
                console.log(`   🖼️ Gemini: adding base64 image (${match[1]}, ${Math.round(match[2].length / 1024)}KB)`);
                geminiParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
              }
            } else if (url.startsWith('http')) {
              console.log(`   🖼️ Gemini: fetching remote image: ${url.slice(0, 80)}...`);
              const imgRes = await safeFetch(url);
              if (imgRes.ok) {
                const buf = Buffer.from(await imgRes.arrayBuffer());
                const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
                const mimeType = contentType.split(';')[0].trim();
                console.log(`   ✅ Gemini: fetched image (${mimeType}, ${Math.round(buf.length / 1024)}KB)`);
                geminiParts.push({ inlineData: { mimeType, data: buf.toString('base64') } });
              } else {
                console.warn(`   ❌ Gemini: image fetch failed with status ${imgRes.status}`);
              }
            }
          } catch (imgErr) {
            console.warn('⚠️ Failed to fetch image for Gemini:', imgErr?.message || imgErr);
          }
        }
        console.log(`   📦 Gemini parts: ${geminiParts.length} total (1 text + ${geminiParts.length - 1} images)`);
        const _gemCap = clampForProvider(pickOutputCap({
          wantsActions,
          hasImages: effectiveImageUrls.length > 0,
          // See note at the OpenAI invoke call: skipping `intent` lets
          // pickOutputCap use OUTPUT_CAPS.chat instead of the broken
          // pre-generation 'chat_short' classification (2500).
        }), geminiModel);
        const requestBody = {
            contents: [{
              parts: geminiParts
            }],
            generationConfig: {
              maxOutputTokens: _gemCap,
              temperature: 0.7
            }
        };
        // Try Google's context cache first — for our static system prompt this
        // is a 50-75% savings on input-token cost on repeat calls. Falls back
        // to inline systemInstruction silently if cache create fails or the
        // prompt is too small to cache.
        if (gemSys) {
          const _gemCacheName = await getOrCreateGeminiCache(gemSys, geminiModel);
          if (_gemCacheName) {
            requestBody.cachedContent = _gemCacheName;
          } else {
            requestBody.systemInstruction = { parts: [{ text: gemSys }] };
          }
        }
        
        let geminiRes;
        let apiVersion = 'v1beta';
        let apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
        
        console.log(`   Trying ${apiVersion} endpoint: ${apiUrl.replace(process.env.GOOGLE_API_KEY, 'KEY_HIDDEN')}`);
        
        geminiRes = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(requestBody)
        });

        console.log(`   Response status: ${geminiRes.status} ${geminiRes.statusText}`);

        // If v1beta fails with 404, try v1 endpoint
        if (!geminiRes.ok && geminiRes.status === 404) {
          console.log('⚠️ v1beta returned 404, trying v1 endpoint...');
          apiVersion = 'v1';
          apiUrl = `https://generativelanguage.googleapis.com/v1/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
          console.log(`   Trying ${apiVersion} endpoint: ${apiUrl.replace(process.env.GOOGLE_API_KEY, 'KEY_HIDDEN')}`);
          
          geminiRes = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });
          
          console.log(`   v1 Response status: ${geminiRes.status} ${geminiRes.statusText}`);
        }

        // If still failing, try with versioned model name
        if (!geminiRes.ok && geminiRes.status === 404 && geminiModel === 'gemini-1.5-flash') {
          console.log('⚠️ Trying with versioned model name: gemini-1.5-flash-002');
          geminiModel = 'gemini-1.5-flash-002';
          apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GOOGLE_API_KEY}`;
          
          geminiRes = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
          });
          
          console.log(`   Versioned model response status: ${geminiRes.status} ${geminiRes.statusText}`);
        }

        if (!geminiRes.ok) {
          const errorData = await geminiRes.json().catch(() => ({}));
          console.error('❌ Gemini API Error Details:', JSON.stringify(errorData, null, 2));
          console.error('   Status:', geminiRes.status);
          console.error('   Status Text:', geminiRes.statusText);
          console.error('   Model tried:', geminiModel);
          console.error('   API version tried:', apiVersion);
          
          const errorMsg = errorData.error?.message || errorData.message || geminiRes.statusText;
          const errorReason = errorData.error?.status || errorData.error?.code || '';
          const errorDetails = errorData.error?.details || '';
          
          let fullErrorMsg = `Gemini API Error: ${errorMsg}`;
          if (errorReason) fullErrorMsg += ` (${errorReason})`;
          if (errorDetails) fullErrorMsg += ` - ${JSON.stringify(errorDetails)}`;
          fullErrorMsg += `. Status: ${geminiRes.status}. Model: ${geminiModel}. API Version: ${apiVersion}.`;
          fullErrorMsg += ` Please verify your API key is valid and has access to Gemini API.`;
          
          throw new Error(fullErrorMsg);
        }
        
        const data = await geminiRes.json();
        const finishReason = data.candidates?.[0]?.finishReason || 'unknown';
        console.log(`✅ Gemini API Response received (finishReason=${finishReason})`);
        if (finishReason === 'MAX_TOKENS') console.warn('⚠️ Gemini response was truncated by token limit!');
        responseText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        usageData = extractGeminiUsage(data);
        
        if (!responseText) {
          console.warn('⚠️ Empty response from Gemini. Full response:', JSON.stringify(data, null, 2));
          throw new Error('Gemini returned an empty response. Please check the API response format.');
        }

      } else if (actualModel.includes('grok')) {
        // xAI Grok
        if (!process.env.XAI_API_KEY) {
          console.error('❌ XAI_API_KEY not found in environment variables');
          return res.status(500).json({ 
            error: 'xAI API key not configured. Please set XAI_API_KEY in your .env file.' 
          });
        }

        // Map legacy names and keep direct modern IDs
        let grokModel = actualModel;
        if (actualModel === 'grok-beta' || actualModel === 'grok') {
          grokModel = 'grok-4-fast-non-reasoning';
        }

        const { system: grokSys, user: grokUser } = splitPromptForProvider(prompt);
        const grokMessages = [];
        if (grokSys) grokMessages.push({ role: 'system', content: grokSys });
        let grokContent = grokUser;
        if (effectiveImageUrls.length > 0) {
          const parts = [{ type: 'text', text: grokUser }];
          for (const url of effectiveImageUrls) {
            parts.push({ type: 'image_url', image_url: { url } });
          }
          grokContent = parts;
        }
        grokMessages.push({ role: 'user', content: grokContent });

        const _grokCap = clampForProvider(pickOutputCap({
          wantsActions,
          hasImages: effectiveImageUrls.length > 0,
          // See note at the OpenAI invoke call: skipping `intent` lets
          // pickOutputCap use OUTPUT_CAPS.chat instead of the broken
          // pre-generation 'chat_short' classification (2500).
        }), grokModel);
        const grokRes = await fetch('https://api.x.ai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.XAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: grokModel,
            messages: grokMessages,
            max_tokens: _grokCap
          })
        });

        if (!grokRes.ok) {
          const errorData = await grokRes.json().catch(() => ({}));
          console.error('❌ Grok API Error:', errorData);
          throw new Error(`Grok: ${errorData.error?.message || grokRes.statusText}`);
        }
        const data = await grokRes.json();
        responseText = data.choices?.[0]?.message?.content?.trim() || '';
        usageData = extractGrokUsage(data);

      } else {
        console.error(`❌ Unsupported model: ${actualModel} (original: ${model})`);
        return res.status(400).json({ 
          error: `Unsupported model: ${actualModel}. Supported models: lykn, or any Gemini / GPT / Claude / Grok variant.` 
        });
      }

      break; // provider succeeded, exit retry loop
        } catch (_provErr) {
          const _msg = String(_provErr?.message || '');
          if (isRetryableProviderError(_msg) && _ii < _invokeModels.length - 1) {
            console.warn(`⚠️ ${actualModel} rate limited: ${_msg.slice(0, 200)}, trying ${_invokeModels[_ii + 1]}…`);
            continue;
          }
          throw _provErr;
        }
      } // end provider retry loop

      if (!responseText) {
        console.warn('⚠️ Empty response from AI model');
        responseText = 'No response generated. Please try again or check your API keys.';
      }

      // Validate YouTube URLs in the response — replace hallucinated ones with real search results
      if (process.env.YOUTUBE_API_KEY && !wantsActions) {
        const ytUrlRe = /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([\w-]{11})/g;
        const foundUrls = [];
        let ytMatch;
        while ((ytMatch = ytUrlRe.exec(responseText)) !== null) {
          foundUrls.push({ full: ytMatch[0], videoId: ytMatch[1], index: ytMatch.index });
        }
        if (foundUrls.length > 0) {
          const validationResults = await Promise.all(
            foundUrls.map(async ({ videoId }) => {
              try {
                const checkUrl = `https://www.googleapis.com/youtube/v3/videos?part=id&id=${videoId}&key=${process.env.YOUTUBE_API_KEY}`;
                const checkRes = await fetch(checkUrl, { signal: AbortSignal.timeout(5000) });
                if (!checkRes.ok) return { videoId, valid: false };
                const checkData = await checkRes.json();
                return { videoId, valid: Array.isArray(checkData.items) && checkData.items.length > 0 };
              } catch {
                return { videoId, valid: false };
              }
            })
          );
          const invalidIds = new Set(validationResults.filter(r => !r.valid).map(r => r.videoId));
          if (invalidIds.size > 0) {
            console.warn(`⚠️ Found ${invalidIds.size} invalid YouTube video ID(s) in AI response: ${[...invalidIds].join(', ')}`);
            const searchQuery = buildYouTubeSearchQuery(pureUserMessage || searchText);
            let replacementUrl = "";
            try {
              const fallbackUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(searchQuery)}&maxResults=1&type=video&videoEmbeddable=true&key=${process.env.YOUTUBE_API_KEY}`;
              const fallbackRes = await fetch(fallbackUrl, { signal: AbortSignal.timeout(5000) });
              if (fallbackRes.ok) {
                const fallbackData = await fallbackRes.json();
                const topResult = fallbackData.items?.[0];
                if (topResult?.id?.videoId) {
                  replacementUrl = `https://www.youtube.com/watch?v=${topResult.id.videoId}`;
                }
              }
            } catch { /* best-effort */ }
            for (const badId of invalidIds) {
              const badPattern = new RegExp(`https?:\\/\\/(?:www\\.)?(?:youtube\\.com\\/watch\\?v=|youtu\\.be\\/|youtube\\.com\\/embed\\/|youtube\\.com\\/shorts\\/)${badId.replace(/[-]/g, '\\-')}`, 'g');
              if (replacementUrl) {
                responseText = responseText.replace(badPattern, replacementUrl);
                console.log(`🔄 Replaced invalid YouTube ID ${badId} with ${replacementUrl}`);
              } else {
                responseText = responseText.replace(badPattern, '');
                console.log(`🗑️ Removed invalid YouTube URL with ID ${badId}`);
              }
            }
          }
        }
      }

      // Fire-and-forget usage logging
      if (usageData.input_tokens === 0 && usageData.output_tokens === 0) {
        usageData = { input_tokens: estimateTokens(prompt), output_tokens: estimateTokens(responseText) };
      }
      const actionType = classifyActionType('invoke', {
        promptLength: prompt?.length || 0,
        responseLength: responseText?.length || 0,
        hasImages: imageUrls.length > 0,
        intent,
      });
      getOrCreateSession(req.user?.id, chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id,
          userId: req.user?.id,
          actionType,
          model: actualModel,
          provider: detectProvider(actualModel),
          inputTokens: usageData.input_tokens,
          outputTokens: usageData.output_tokens,
        });
      }).catch(() => {});

      if (wantsActions) {
        const parsed = extractFirstJsonObject(responseText);
        const assistant = String(parsed?.assistant || parsed?.response || "").trim() || String(responseText || "").trim();
        let actions = Array.isArray(parsed?.actions) ? parsed.actions : [];
        const followUpsRaw = parsed?.follow_up_questions ?? parsed?.followUpQuestions ?? parsed?.followUps;
        const followUpQuestions = Array.isArray(followUpsRaw) ? followUpsRaw.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 6) : [];

        console.log(`[Actions] parsed=${!!parsed} actions=${actions.length} types=${actions.map(a => a?.type).join(',')} responseLen=${String(responseText || '').length}${!parsed ? ` rawResponse=${String(responseText || '').slice(0, 500)}` : ''}`);

        // Rescue: if the AI dumped action/block markup into the assistant text
        // instead of returning it through the actions array, extract and apply
        // those actions and strip the markup from the user-visible reply. We
        // forgive several common shapes:
        //   - `[CREATE_BLOCK:{...}]`
        //   - bare `{"type":"create_*", ...}` JSON objects or arrays of them
        //   - ```json fenced blocks containing the above
        //   - `{"actions":[...]}` envelope objects
        const ACTION_TYPE_PREFIX_RE = /^(create_|update_|delete_|move_|resize_|color_|connect_|disconnect_|remove_connection|add_wire|edit_block|update_block|update_text_block|update_list|update_spreadsheet|update_code_block|append_notes|update_notes|organize_grid|auto_organize|auto_layout|create_database_relation)/i;
        const SHORTHAND_TO_ACTION = {
          heading: 'create_heading', h1: 'create_heading', h2: 'create_h2', h3: 'create_h3',
          quote: 'create_quote', callout: 'create_quote',
          list: 'create_list', todo: 'create_list',
          code: 'create_code_block',
          sheet: 'create_sheet', paper: 'create_sheet', document: 'create_sheet',
          spreadsheet: 'create_spreadsheet',
          table: 'create_table',
          brick: 'create_text', card: 'create_text', sticky: 'create_text', text: 'create_text',
        };
        const normalizeRescuedAction = (obj) => {
          if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') return null;
          const tLower = obj.type.toLowerCase();
          let actionType = tLower;
          if (!ACTION_TYPE_PREFIX_RE.test(tLower)) {
            const mapped = SHORTHAND_TO_ACTION[tLower];
            if (!mapped) return null;
            actionType = mapped;
          }
          const action = { ...obj, type: actionType };
          if (obj.position && typeof obj.position === 'object') {
            if (action.x == null && obj.position.x != null) action.x = Number(obj.position.x);
            if (action.y == null && obj.position.y != null) action.y = Number(obj.position.y);
            delete action.position;
          }
          if (actionType === 'create_heading' && action.level == null) {
            action.level = tLower === 'h2' ? 2 : tLower === 'h3' ? 3 : 1;
          }
          return action;
        };
        const tryParseLooseJson = (raw) => {
          try { return JSON.parse(raw); } catch {}
          try { return JSON.parse(repairUnescapedQuotes(String(raw))); } catch {}
          if (!raw.includes('"') && raw.includes("'")) {
            try { return JSON.parse(raw.replace(/'/g, '"')); } catch {}
          }
          return null;
        };
        const tryExtractEnvelopeServer = (text) => {
          const trimmed = String(text || '').trim();
          if (!trimmed) return null;
          const tryShape = (candidate) => {
            if (!candidate) return [];
            if (Array.isArray(candidate)) return candidate.map(normalizeRescuedAction).filter(Boolean);
            if (typeof candidate === 'object' && Array.isArray(candidate.actions)) return candidate.actions.map(normalizeRescuedAction).filter(Boolean);
            if (candidate && typeof candidate === 'object' && typeof candidate.type === 'string') {
              const a = normalizeRescuedAction(candidate);
              return a ? [a] : [];
            }
            return [];
          };
          // Assistant-only envelope detector. Mirrors the client-side fix in
          // chatSendOrchestrator.ts — a `{ "assistant": "...", "actions": [] }`
          // blob with no actions is still an envelope, and the user must never
          // see the raw JSON in the chat bubble.
          const looksLikeAssistantEnvelope = (candidate) =>
            candidate
            && typeof candidate === 'object'
            && !Array.isArray(candidate)
            && (typeof candidate.assistant === 'string' || typeof candidate.response === 'string');
          for (const [openCh, closeCh] of [['{', '}'], ['[', ']']]) {
            const start = trimmed.indexOf(openCh);
            const end = trimmed.lastIndexOf(closeCh);
            if (start < 0 || end <= start) continue;
            const slice = trimmed.slice(start, end + 1);
            const parsed = tryParseLooseJson(slice);
            const actions = tryShape(parsed);
            if (actions.length) {
              return {
                actions,
                assistant: parsed && !Array.isArray(parsed) && typeof parsed === 'object' ? String(parsed.assistant || parsed.response || '').trim() : '',
                start,
                end: end + 1,
                isEnvelope: true,
              };
            }
            if (looksLikeAssistantEnvelope(parsed)) {
              return {
                actions: [],
                assistant: String(parsed.assistant || parsed.response || '').trim(),
                start,
                end: end + 1,
                isEnvelope: true,
              };
            }
          }
          return null;
        };
        const findActionJsonSpansServer = (text) => {
          const spans = [];
          for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch !== '{' && ch !== '[') continue;
            let depth = 0;
            let inString = false;
            let escape = false;
            let end = -1;
            for (let j = i; j < text.length; j++) {
              const c = text[j];
              if (escape) { escape = false; continue; }
              if (c === '\\') { escape = true; continue; }
              if (c === '"') { inString = !inString; continue; }
              if (inString) continue;
              if (c === '{' || c === '[') depth++;
              else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0) { end = j; break; }
              }
            }
            if (end < 0) break;
            const slice = text.slice(i, end + 1);
            const parsed = tryParseLooseJson(slice);
            let extracted = [];
            if (Array.isArray(parsed)) {
              extracted = parsed.map(normalizeRescuedAction).filter(Boolean);
            } else if (parsed && Array.isArray(parsed.actions)) {
              extracted = parsed.actions.map(normalizeRescuedAction).filter(Boolean);
            } else if (parsed && typeof parsed === 'object') {
              const a = normalizeRescuedAction(parsed);
              if (a) extracted = [a];
            }
            if (extracted.length) {
              spans.push({ start: i, end: end + 1, actions: extracted });
              i = end;
            }
          }
          return spans;
        };

        // Translate AI-invented `<add_blocks>...</add_blocks>` /
        // `<add_wires>...</add_wires>` tag wrappers into canonical actions
        // and strip the tags from the chat text. Models occasionally invent
        // this XML-ish shape instead of using the JSON `actions` array.
        const convertAddBlockToActionServer = (blk) => {
          if (!blk || typeof blk !== 'object') return null;
          const rawType = String(blk.type || blk.kind || blk.blockType || '').toLowerCase();
          const variant = String(blk.variant || blk.textVariant || '').toLowerCase();
          const placeholderId = blk.id || blk.placeholderId || blk.refId;
          const content = blk.content != null ? String(blk.content) : (blk.text != null ? String(blk.text) : '');
          const x = Number.isFinite(blk.x) ? Number(blk.x) : undefined;
          const y = Number.isFinite(blk.y) ? Number(blk.y) : undefined;
          const width = Number.isFinite(blk.w) ? Number(blk.w) : Number.isFinite(blk.width) ? Number(blk.width) : undefined;
          const height = Number.isFinite(blk.h) ? Number(blk.h) : Number.isFinite(blk.height) ? Number(blk.height) : undefined;
          const base = { placeholderId, content, x, y, width, height };
          if (rawType === 'heading' || rawType === 'h1') return { ...base, type: 'create_heading', level: 1 };
          if (rawType === 'h2') return { ...base, type: 'create_h2', level: 2 };
          if (rawType === 'h3') return { ...base, type: 'create_h3', level: 3 };
          if (rawType === 'quote' || rawType === 'callout') return { ...base, type: 'create_quote' };
          if (rawType === 'code') return { ...base, type: 'create_code_block', language: blk.language || 'plaintext' };
          if (rawType === 'sheet' || rawType === 'paper' || rawType === 'document') return { ...base, type: 'create_sheet', title: blk.title };
          if (rawType === 'spreadsheet') return { ...base, type: 'create_spreadsheet', rows: blk.rows, cols: blk.cols };
          if (rawType === 'table') return { ...base, type: 'create_table', headers: blk.headers, rows: blk.rows };
          if (rawType === 'list' || rawType === 'todo' || rawType === 'todolist' || rawType === 'checklist') return { ...base, type: 'create_list', listType: blk.listType || 'todo', items: blk.items };
          if (rawType === 'toggle') return { ...base, type: 'create_toggle', items: blk.items };
          if (rawType === 'kanban' || rawType === 'task_board' || rawType === 'taskboard') return { ...base, type: 'create_task_board', title: blk.title, columns: blk.columns };
          if (rawType === 'design_board' || rawType === 'designboard') return { ...base, type: 'create_design_board', title: blk.title };
          if (rawType === 'youtube') return { ...base, type: 'create_youtube_block', url: blk.url };
          if (rawType === 'video') return { ...base, type: 'create_video_block', url: blk.url };
          if (rawType === 'image') return { ...base, type: 'create_image_block', url: blk.url || blk.src };
          if (rawType === 'embed' || rawType === 'website' || rawType === 'site' || rawType === 'iframe') {
            return { ...base, type: 'create_embed', url: blk.url || blk.src, mode: blk.mode || 'embed', name: blk.name || blk.title };
          }
          if (rawType === 'link' || rawType === 'bookmark' || rawType === 'url') {
            return { ...base, type: 'create_link', url: blk.url || blk.src, mode: blk.mode || 'link', name: blk.name || blk.title };
          }
          if (rawType === 'media') return { ...base, type: 'create_media', url: blk.url || blk.src, mode: blk.mode };
          if (rawType === 'text' || rawType === 'brick' || rawType === 'card' || rawType === 'sticky' || !rawType) {
            if (variant === 'h1') return { ...base, type: 'create_heading', level: 1 };
            if (variant === 'h2') return { ...base, type: 'create_h2', level: 2 };
            if (variant === 'h3') return { ...base, type: 'create_h3', level: 3 };
            return { ...base, type: 'create_text' };
          }
          return null;
        };
        const convertAddWireToActionServer = (wire) => {
          if (!wire || typeof wire !== 'object') return null;
          const fromId = String(wire.from || wire.fromId || wire.fromPlaceholder || '').trim();
          const toId = String(wire.to || wire.toId || wire.toPlaceholder || '').trim();
          if (!fromId || !toId) return null;
          const fromSide = String(wire.fromAnchor || wire.fromSide || '').trim() || undefined;
          const toSide = String(wire.toAnchor || wire.toSide || '').trim() || undefined;
          return { type: 'connect_blocks', fromId, toId, fromSide, toSide };
        };

        let cleanAssistant = assistant;
        const xmlRescued = [];
        const xmlTagHandlers = [
          { open: /<\s*add[_-]?blocks?\s*>([\s\S]*?)<\s*\/\s*add[_-]?blocks?\s*>/gi, convert: convertAddBlockToActionServer },
          { open: /<\s*create[_-]?blocks?\s*>([\s\S]*?)<\s*\/\s*create[_-]?blocks?\s*>/gi, convert: convertAddBlockToActionServer },
          { open: /<\s*blocks?\s*>([\s\S]*?)<\s*\/\s*blocks?\s*>/gi, convert: convertAddBlockToActionServer },
          { open: /<\s*add[_-]?wires?\s*>([\s\S]*?)<\s*\/\s*add[_-]?wires?\s*>/gi, convert: convertAddWireToActionServer },
          { open: /<\s*wires?\s*>([\s\S]*?)<\s*\/\s*wires?\s*>/gi, convert: convertAddWireToActionServer },
          { open: /<\s*connect[_-]?blocks?\s*>([\s\S]*?)<\s*\/\s*connect[_-]?blocks?\s*>/gi, convert: convertAddWireToActionServer },
        ];
        for (const handler of xmlTagHandlers) {
          cleanAssistant = cleanAssistant.replace(handler.open, (_full, innerRaw) => {
            const inner = String(innerRaw || '').trim();
            if (!inner) return '';
            const parsed = tryParseLooseJson(inner);
            const entries = Array.isArray(parsed)
              ? parsed
              : parsed && typeof parsed === 'object' && Array.isArray(parsed.items)
                ? parsed.items
                : parsed && typeof parsed === 'object'
                  ? [parsed]
                  : [];
            for (const e of entries) {
              const a = handler.convert(e);
              if (a) xmlRescued.push(a);
            }
            return '';
          });
        }
        if (xmlRescued.length) {
          actions = [...actions, ...xmlRescued];
          console.log(`[Actions] Rescued ${xmlRescued.length} action(s) from <add_blocks>/<add_wires>-style tags`);
        }

        if (!actions.length) {
          const rescued = [];
          // 1. `[CREATE_BLOCK:{...}]`
          const blockMarkupRe = /\[CREATE_BLOCK:\s*(\{[^]*?\})\s*\]/g;
          let mm;
          while ((mm = blockMarkupRe.exec(cleanAssistant)) !== null) {
            const parsed = tryParseLooseJson(mm[1]);
            if (parsed) {
              const a = normalizeRescuedAction({ ...parsed, type: parsed.type || 'text' });
              if (a) rescued.push(a);
            }
          }
          cleanAssistant = cleanAssistant.replace(/\[CREATE_BLOCK:\s*\{[^]*?\}\s*\]/g, '');

          // 2. ```json ... ``` fences (try whole-fence envelope first, then spans)
          const fenceSpansToRemove = [];
          const fenceRe = /```(?:json|JSON|js|javascript)?\s*([\s\S]*?)```/g;
          let ff;
          while ((ff = fenceRe.exec(cleanAssistant)) !== null) {
            const inner = ff[1].trim();
            if (!inner) continue;
            let fenceActions = [];
            let fenceAssistant = '';
            let envelopeFound = false;
            const env = tryExtractEnvelopeServer(inner);
            if (env && env.isEnvelope) {
              fenceActions = env.actions;
              fenceAssistant = env.assistant;
              envelopeFound = true;
            } else {
              const innerSpans = findActionJsonSpansServer(inner);
              for (const s of innerSpans) fenceActions.push(...s.actions);
            }
            if (!fenceActions.length && !envelopeFound) continue;
            for (const a of fenceActions) rescued.push(a);
            fenceSpansToRemove.push({ start: ff.index, end: ff.index + ff[0].length, replacement: fenceAssistant });
          }
          for (let i = fenceSpansToRemove.length - 1; i >= 0; i--) {
            const { start, end, replacement } = fenceSpansToRemove[i];
            cleanAssistant = cleanAssistant.slice(0, start) + (replacement || '') + cleanAssistant.slice(end);
          }

          // 3. Whole-text envelope (the most common shape — `{"assistant":"...","actions":[...]}`
          // emitted as the entire response, often with unescaped quotes inside
          // string values that defeat the strict brace walker). We also unwrap
          // assistant-only envelopes (no actions / empty actions array) so the
          // user never sees raw `{ "assistant": "..." }` in the chat bubble.
          const wholeTrimmed = cleanAssistant.trim();
          if (wholeTrimmed && (wholeTrimmed[0] === '{' || wholeTrimmed[0] === '[')) {
            const env = tryExtractEnvelopeServer(wholeTrimmed);
            if (env && env.isEnvelope) {
              for (const a of env.actions) rescued.push(a);
              const offset = cleanAssistant.indexOf(wholeTrimmed);
              const head = cleanAssistant.slice(0, offset);
              const tail = cleanAssistant.slice(offset + env.end);
              cleanAssistant = head + (env.assistant || '') + tail;
            }
          }

          // 4. Bare action JSON literals scattered alongside prose
          const bareSpans = findActionJsonSpansServer(cleanAssistant);
          if (bareSpans.length) {
            for (const s of bareSpans) rescued.push(...s.actions);
            let out = '';
            let cursor = 0;
            for (const s of bareSpans) {
              out += cleanAssistant.slice(cursor, s.start);
              cursor = s.end;
            }
            out += cleanAssistant.slice(cursor);
            cleanAssistant = out;
          }

          if (rescued.length) {
            actions = rescued;
            console.log(`[Actions] Rescued ${rescued.length} action(s) from inline markup/JSON in assistant text`);
          }
        } else {
          // Even when actions are present, scrub stray `[CREATE_BLOCK:...]` from
          // the visible chat text so duplicates don't appear.
          cleanAssistant = cleanAssistant.replace(/\[CREATE_BLOCK:\s*\{[^]*?\}\s*\]/g, '');
        }
        cleanAssistant = cleanAssistant.replace(/\n{3,}/g, '\n\n').trim();

        // Deterministic fallback: if the model didn't return actions,
        // infer block creation from the user request so blocks still get created.
        if (!actions.length) {
          const s = String(wantsActionsUserText || "").toLowerCase();
          const wants = /\b(create|make|build|add|start|setup|set up|need|want|would like|place|put|drop|insert|generate)\b/i.test(s);
          const wantsSheet = /\b(paper|essay|report|document)\b/i.test(s) || /\bwrite\s+(a|an|the)\b/i.test(s);
          const wantsTable = /\b(table|comparison|chart)\b/i.test(s) && !/\b(spreadsheet)\b/i.test(s);
          const wantsSpreadsheet = /\b(spreadsheet|budget|tracker)\b/i.test(s);
          const wantsList = /\b(todo|to-?do|checklist|tasks|list)\b/i.test(s);
          const wantsHeading = /\b(heading|h1|h2|h3)\b/i.test(s);
          const wantsQuote = /\b(quote|callout)\b/i.test(s);
          const wantsCode = /\b(code\s*block)\b/i.test(s);
          const wantsTaskBoard = /\b(task\s*board|kanban)\b/i.test(s);
          const wantsDesignBoard = /\b(design\s*board|design\s*canvas)\b/i.test(s);
          const wantsTextBrick = /\b(text\s*(?:block|brick)|card|sticky\s*note|brick)\b/i.test(s);
          const wantsOrganize = /\b(organize|tidy|clean\s*up|auto[- ]?(?:layout|arrange)|sort\s*(?:the|my)?\s*(?:grid|board|bricks|blocks))\b/i.test(s);
          if (wants && wantsSheet) actions = [{ type: "create_sheet" }];
          else if (wants && wantsTable) actions = [{ type: "create_table", headers: ["Column 1", "Column 2", "Column 3"], rows: [["", "", ""]] }];
          else if (wants && wantsSpreadsheet) actions = [{ type: "create_spreadsheet", rows: 30, cols: 10 }];
          else if (wants && wantsList) actions = [{ type: "create_list", listType: "todo", items: ["Task 1", "Task 2", "Task 3"] }];
          else if (wants && wantsHeading) actions = [{ type: "create_heading", level: /h2/i.test(s) ? 2 : /h3/i.test(s) ? 3 : 1, content: "" }];
          else if (wants && wantsQuote) actions = [{ type: "create_quote", content: "" }];
          else if (wants && wantsCode) actions = [{ type: "create_code_block", language: "plaintext", content: "" }];
          else if (wants && wantsTaskBoard) actions = [{ type: "create_task_board", title: "Task Board", columns: [{ title: "To Do", cards: [] }, { title: "In Progress", cards: [] }, { title: "Done", cards: [] }] }];
          else if (wants && wantsDesignBoard) actions = [{ type: "create_design_board" }];
          else if (wants && wantsTextBrick) actions = [{ type: "create_text", content: "" }];
          else if (wantsOrganize) actions = [{ type: "organize_grid", strategy: "grid" }];
        }

        return res.json({
          response: stripToolSyntaxFromText(cleanAssistant || assistant),
          actions,
          followUpQuestions,
        });
      }

      res.json({ response: stripToolSyntaxFromText(responseText) });
    } catch (error) {
      console.error('❌ AI Error:', error.message);
      console.error('❌ Full error:', error.stack);
      res.status(500).json({ 
        error: AI_TEMPORARY_FAILURE_TEXT
      });
    }
  });
}
