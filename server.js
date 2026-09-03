// server.js
import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import multer from 'multer';
import * as cheerio from 'cheerio';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import Stripe from 'stripe';
import { searchWeb, formatSearchResultsForPrompt, extractSourcesFromSearchPrompt } from './lib/exterior/webSearch.js';
import { runDeepResearchForPrompt } from './lib/exterior/deepResearch.js';
import { fetchWebPage } from './lib/exterior/webFetch.js';
import { assertUrlSafe, safeFetch } from './lib/exterior/ssrfGuard.js';
import { isArtifactsHost } from './lib/exterior/fileProxy.js';
import { pickDesignSystem, formatDesignSystemBlock } from './lib/exterior/designSystems.js';
import { pickDesignGuide, formatDesignGuideBlock } from './lib/exterior/designGuides.js';
import { persistCapabilityArtifact } from './lib/exterior/capabilityStorage.js';
import { chunkTextForSynthesis } from './synthesis-service.js';
import { contextualizeChunks } from './lib/rag/contextualize.js';
import {
  pollRunningBuilds,
  claimUnannouncedBuilds,
  isCursorBuildsConfigured,
} from './lib/cursor/cursorBuilds.js';
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
  startSessionCleanup,
} from './usageTracking.js';
import {
  isModelAllowedForPlan,
  defaultModelForTier,
  classifyModel,
} from './src/lib/modelTiers.js';
import { PLAN_LIMITS, CREDIT_PACKS, creditPackById } from './src/lib/pricing-config.js';
import { CHAT_USAGE_GATE_PATHS } from './server/ai/chatRouting/chatRoutingConfig.js';
import {
  getCreditWallet,
  markTopupPayer,
} from './lib/billing/creditWallet.js';
import { getUsageBalance } from './lib/billing/usageBalance.js';
import { logStripePriceConfig } from './lib/billing/stripePriceConfig.js';
import { compressConversation as compressConversationForPrompt } from './src/lib/ai/conversationFormat.js';
import { makeRssPoller } from './rss-service.js';
import { registerCustomModelRoutes } from './custom-models-routes.js';
import { registerAccountRoutes } from './server/routes/account.routes.js';
import { registerAdminRoutes } from './server/routes/admin.routes.js';
import { registerAppleAuthRoutes, registerEmailAuthRoutes } from './server/routes/authFlows.routes.js';
import { registerBillingRoutes } from './server/routes/billing.routes.js';
import { registerMetricsRoutes, registerFeedbackRoutes, registerProjectInviteRoutes } from './server/routes/platform.routes.js';
import { registerClientErrorRoute, registerHealthRoute, registerFileProxyAndArtifactRoutes } from './server/routes/preLimiterPlatform.routes.js';
import { registerStripeWebhook } from './server/routes/stripeWebhook.routes.js';
import { registerAssistRoutes } from './server/routes/assist.routes.js';
import { registerCustomConnectionsRoutes } from './server/routes/connections.routes.js';
import { registerCalendarConnectionRoutes } from './server/routes/calendarConnections.routes.js';
import { registerCursorCredentialRoutes } from './server/routes/cursorCredentials.routes.js';
import { registerConnectionServiceRoutes } from './server/routes/connectionService.routes.js';
import { registerMcpRoutes } from './server/routes/mcp.routes.js';
import { pollDueCalendarConnections } from './lib/calendar/calendarService.js';
import {
  registerDesktopRoutes,
  getBrowserControlProvider,
  pickBrowserControlModel,
} from './server/routes/desktop.routes.js';
import { registerFeedsRoutes } from './server/routes/feeds.routes.js';
import { registerVoiceRoutes } from './server/routes/voice.routes.js';
import { registerFilesRoutes } from './server/routes/files.routes.js';
import { registerStorageRoutes } from './server/routes/storage.routes.js';
import { registerSynthesisRoutes, registerSynthesisMaintenanceRoutes } from './server/routes/synthesis.routes.js';
import { registerUsageRoutes } from './server/routes/usage.routes.js';
import { registerModelPlatformRoutes } from './server/routes/modelPlatform.routes.js';
import { bindModelSettingsClient } from './lib/models/userModelSettings.js';
import { syncOpenRouterCatalog } from './lib/inference/openRouterCatalog.js';
import { registerWebtoolsRoutes } from './server/routes/webtools.routes.js';
import { registerAiModelsRoute } from './server/ai/chatModels.routes.js';
import { registerAiGuestStreamRoute } from './server/ai/chatGuest.routes.js';
import { registerAiFeedbackRoute } from './server/ai/chatFeedback.routes.js';
import { registerAiInvokeRoute } from './server/ai/chatInvoke.routes.js';
import { registerAiStreamRoutes } from './server/ai/chatStream.routes.js';
import { registerYouTubeRoutes } from './server/routes/youtube.routes.js';
import {
  isTogetherDedicatedEndpointError,
  isTogetherInferenceModel,
  isTogetherLoraInferenceRetryableError,
} from './lib/lora/togetherLora.js';
import { buildTogetherChatBody } from './lib/lora/togetherServerlessLora.js';
import {
  buildTogetherLoraMessages,
  extractSupplementalUserContext,
} from './lib/lora/togetherLoraChat.js';
import {
  resolveCustomModelChatContext,
  applyCustomModelOverlayToPrompt,
  buildProviderModelChain,
} from './lib/modelBuilder/customModelChat.js';
import { resolveCustomModelChatTools } from './lib/modelBuilder/customModelChatTools.js';
import { loadCustomModelVaultKnowledgeSection } from './lib/modelBuilder/customModelKnowledge.js';
import {
  readIsMainAgent,
  readSubModelIds,
  loadSubModelRoster,
  formatMainAgentOrchestrationBlock,
  loadPublishedRoster,
  formatDefaultMainAgentBlock,
} from './lib/modelBuilder/mainAgentOrchestration.js';
import { CUSTOM_MODELS_ENABLED } from './lib/customModelsEnabled.js';
import { runSubModelDelegate } from './lib/modelBuilder/runSubModelDelegate.js';
import {
  createSubModelTask,
  listSubModelTasks,
  getSubModelTask,
  listUndeliveredCompletedTasks,
  markSubModelTasksNotified,
} from './lib/modelBuilder/subModelTasksService.js';
import { enqueueSubModelTask } from './lib/modelBuilder/subModelTaskRunner.js';
import {
  getCustomModelChatPersonaStatic,
  getCustomModelStreamPersonaFull,
} from './lib/modelBuilder/lyknCustomModelRuntimePersona.js';
import {
  formatProjectStateForPromptInLykn,
  formatOtherProjectsForPromptOutsideClient,
  loadActiveProjectContext,
  loadProjectContextById,
  loadOtherProjectsForUser,
} from './lib/projectContext.js';
import {
  getMemoryStore,
  ensureLegacyMemoryMigrated,
  resolveChatMemoryTurn,
} from './server/memory/index.js';
import { CHAT_TOOLS, buildChatToolCtx, providerForModel, resolveChatModelLabel, supportsTools } from './mcp-tools/chatTools.js';
import { LOCAL_TOOL_NAMES, looksLikeLocalSystemAsk, mightBeBrowserTaskAsk } from './mcp-tools/localTools.js';
import {
  AGENTS_APPS_CODE_INTENT_RE,
  ARTIFACT_BUILD_VERB_RE,
  MAKING_INTENT_RE,
  MANAGED_SURFACE_INTENT,
  messageWantsAgentTools,
  messageWantsPageFetch,
  messageWantsProjectContext,
  messageWantsSavedRecall,
  messageWantsUserRecallCore,
  messageWantsWebTools,
} from './mcp-tools/chatIntentSignals.js';
import {
  resolveChatTurnDisclosure,
} from './mcp-tools/firstPartyCapabilities.js';
import {
  buildCapabilityToolGuidance,
  buildSlimChatToolGuidance,
} from './mcp-tools/chatToolGuidance.js';
import {
  formatBoundProjectGuidance,
  loadWritableProject,
  stampActiveProject,
} from './lib/projectWriteTarget.js';
import { runAgentLoop, makeToolSyntaxStripper, stripToolSyntaxFromText } from './chat-agent-loop.js';
import { z, validate, setValidationFailureHook } from './validation.js';
import {
  sanitizeUserContent,
  sanitizeTurnArray,
  sanitizeUserContentWithCount,
  sanitizeTurnArrayWithCount,
} from './prompt-sanitizer.js';
import { validateSecrets } from './validateSecrets.js';
import {
  SecurityEvent,
  logSecurityEvent,
  setSecurityLoggerSink,
  buildRateLimitHandler,
  tokenPrefix,
} from './security-logger.js';
import {
  GREETING_PATTERN,
  CASUAL_CHITCHAT_PATTERN,
} from './server/ai/chatIntent.js';
import {
  sha256,
  memCache,
  sanitizeStaleSurfaceLanguage,
  splitPromptForProvider,
  getOrCreateGeminiCache,
  OUTPUT_CAPS,
  getProviderForModel,
  clampForProvider,
  pickOutputCap,
  timingSafeEqualStr,
} from './server/ai/promptUtils.js';
import {
  LYKN_VOICE_DIRECT,
  LYKN_GLASS_MEMORY_ADDENDUM,
  resolveUserRecallMode,
  messageWantsUserRecall,
  USER_RECALL_TURN_PROMPT,
  USER_RECALL_DEEPEN_PROMPT,
  GREETING_TURN_PROMPT,
  messageIsPureGreeting,
  isCasualOverlayAck,
  LYKN_CHAT_PERSONA_STATIC,
  LYKN_STREAM_PERSONA_STATIC,
  GUEST_SYSTEM_PROMPT,
  GLASS_DEMO_ADDENDUM,
  LANDING_ONBOARDING_ADDENDUM,
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
} from './server/ai/chatGuidance.js';
import {
  hasExplicitUrlScrapeIntent,
  scrapeUrl,
  scrapeUrlsFromText,
  needsWebSearch,
  classifyEnrichment,
  shouldEmbedWorkspaceContext,
  isTrivialTurn,
  runWebSearchIfNeeded,
  needsYouTubeSearch,
  buildYouTubeSearchQuery,
  runYouTubeSearchIfNeeded,
} from './server/ai/webEnrichment.js';
import {
  LOCAL_TOOL_WAIT_MS,
  registerLocalToolStream,
  releaseLocalToolStream,
  resolveLocalToolResult,
} from './server/ai/localToolBridge.js';
import { pickUserDisplayName } from './server/ai/userIdentity.js';
import { currentTimeContextLine, localTimeContextLine } from './server/ai/timeContext.js';
import {
  internalHeaders,
  MODEL_CATALOG,
  LYKN_ROUTED_MODELS,
  resolveLyknAlias,
  normalizeRequestedModel,
  pickStrongVisionModel,
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
} from './server/ai/modelInvoke.js';
import {
  bindChatRetrieval,
  createSynthesisUserClient,
  deleteSynthesisChunksForSource,
  replaceSynthesisChunks,
  fetchVaultNotesByUrls,
  openAiEmbedMany,
} from './server/ai/chatRetrieval.js';
import {
  bindChatContext,
  invalidateProjectSectionCache,
  invalidateConnectedToolsCache,
  fetchConnectedToolsSection,
  loadCustomModelForChat,
  fetchCustomModelKnowledgeSection,
  readCustomModelLinkedProjectId,
  fetchProjectSection,
} from './server/ai/chatContext.js';
import {
  bindVoiceBriefing,
  buildVoiceFirstMessage,
  gatherVoiceBriefingData,
  formatVoiceBriefingInstructionBlock,
  buildVoiceBriefingOffer,
} from './server/ai/voiceBriefing.js';
import {
  bindChatToolCtx,
  buildToolCtx,
  PROJECT_WRITE_TOOLS,
} from './server/ai/chatToolCtx.js';
import {
  bindVaultEnrichment,
  indexVaultNoteForSearch,
  enrichVaultNoteSummary,
  findAttachmentsMarkerSpan,
  extractBodyAfterAttachmentsMarker,
  backfillVaultText,
} from './server/ai/vaultEnrichment.js';
import {
  bindBillingService,
  isCompedProEmail,
  COMPED_PRO_PLAN_ID,
  PLAN_IDS,
  BILLING_PERIODS,
  stripeConfigured,
  appUrlFromReq,
  loadBillingRow,
  resolveUserPlan,
  hasSubscriptionAccess,
  hasAppAccessRow,
  hasEstablishedStripeCustomer,
  requireAppAccess,
  billingMePayload,
  rejectIneligibleStudentCheckout,
  buildStripeCheckoutIdentity,
  handleStripeEvent,
  availableCreditPacks,
} from './server/services/billingService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

// SECURITY (Agent 05): startup secrets validation. Runs immediately after
// dotenv.config so any missing / undersized / VITE_-leaked secret is
// caught at boot time, not at first request. In NODE_ENV=production this
// calls process.exit(1) on any fatal finding (Render's auto-restart loop
// then surfaces the failure as a deployment-failed alert — preferable to
// silently running with an undersized cron secret). In development it
// prints warnings and continues so partial dev configs keep working.
//
// SECRET_RULES (the canonical inventory) lives in validateSecrets.js and
// is also referenced by ROTATION_RUNBOOK.md. Per-call floors on
// verifyBackfillSecret / verifyDiscoverIngestSecret /
// verifyAdminIngestSecret match the boot gate (≥32 chars).
validateSecrets();

// Debug: Check if API keys are loaded (without exposing the actual keys)
console.log('🔑 Environment check:');
console.log('  OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  XAI_API_KEY:', process.env.XAI_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  TOGETHER_API_KEY:', process.env.TOGETHER_API_KEY ? '✅ Set' : '⚪ Not set (LoRA training/inference disabled)');
console.log('  YOUTUBE_API_KEY:', process.env.YOUTUBE_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  GOOGLE_CSE_ID:', process.env.GOOGLE_CSE_ID ? '✅ Set' : '⚪ Not set');
console.log('  SERPER_API_KEY:', process.env.SERPER_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  RESEND_API_KEY:', process.env.RESEND_API_KEY ? '✅ Set' : '❌ Missing');
console.log('  SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? '✅ Set' : '⚪ Not set (usage tracking disabled)');
console.log('  BACKFILL_SECRET:', process.env.BACKFILL_SECRET ? '✅ Set' : '⚪ Not set (synthesis backfill disabled)');
console.log('  META_APP_TOKEN:', process.env.META_APP_TOKEN ? '✅ Set' : '⚪ Not set (Instagram/Facebook oEmbed disabled)');
console.log('  STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? '✅ Set' : '⚪ Not set (Stripe billing disabled)');
console.log('  STRIPE_WEBHOOK_SECRET:', process.env.STRIPE_WEBHOOK_SECRET ? '✅ Set' : '⚪ Not set (webhook signature check disabled)');
console.log('  HAI_API_KEY:', process.env.HAI_API_KEY ? '✅ Set (Holo browser control)' : '⚪ Not set (browser control uses OpenAI)');
if (process.env.HAI_API_KEY || process.env.BROWSER_CONTROL_PROVIDER) {
  console.log(`  Browser control: ${getBrowserControlProvider()} → ${pickBrowserControlModel(true)}`);
  if (getBrowserControlProvider() === 'holo') {
    console.log(`  Browser pipeline: ${process.env.BROWSER_SCREEN_READER_MODEL || 'gpt-5.6-luna'} read → Holo act → ${process.env.BROWSER_REPORT_MODEL || 'gpt-4.1-nano'} report`);
  }
}
console.log(
  `  Browser agent (modular): ${process.env.BROWSER_AGENT_MODEL || 'gpt-5.6-terra'} plan/decide → ` +
  `${process.env.BROWSER_AGENT_VERIFY_MODEL || process.env.BROWSER_AGENT_MODEL || 'gpt-5.6-terra'} verify` +
  ` (reasoning: ${process.env.BROWSER_AGENT_REASONING || 'none'})`,
);

const app = express();

// ============================================
// PERIMETER HARDENING (Agent 01)
// ============================================
// LYKN runs on Render (Node) behind their edge proxy, with the frontend
// on Vercel. We don't operate a reverse proxy of our own, so the
// security plumbing that would normally live in nginx/Caddy is set as
// close to the public edge as we can manage — here, in app middleware.
// See SECURITY_REPORT_01.md for the full plan + the open items we
// could not close inside code (Cloudflare/WAF, Supabase IP allowlist).

// Strip the default `X-Powered-By: Express` header so recon scans don't
// trivially fingerprint the stack.
app.disable('x-powered-by');

// Render's edge proxy sits exactly one hop in front of us. Telling
// Express to trust one hop makes req.ip / req.secure / req.protocol
// reflect the real client IP and TLS state instead of the proxy's.
// Downstream rate limiting, audit logging, and any future
// conditional-on-HTTPS logic depend on this being correct.
app.set('trust proxy', 1);

// artifacts.lykn.io (ARTIFACTS_BASE_URL) is a second hostname on this same
// process so shareable HTML opens on an origin isolated from the API.
// Only GET/HEAD /f/:token is allowed on that host — everything else 404s
// so a malicious artifact page cannot call /api/* same-origin.
const ARTIFACTS_FILE_PATH_RE = /^\/f\/[^/]+\/?$/;
app.use((req, res, next) => {
  if (!isArtifactsHost(req.hostname)) return next();
  const method = req.method;
  if (
    (method === 'GET' || method === 'HEAD') &&
    ARTIFACTS_FILE_PATH_RE.test(req.path)
  ) {
    return next();
  }
  return res.status(404).type('text/plain').send('Not found');
});

// Routes that intentionally serve HTML and need looser COOP/CSP so the
// connector OAuth-popup flow (Google, Notion, GitHub, … → LYKN) still
// works. Everything else gets the strict defaults below.
const HTML_OAUTH_PATH_RE = /^\/oauth\//;

app.use((req, res, next) => {
  // Two years, all subdomains. No `preload` — we don't commit to the
  // irrevocable browser preload list until every lykn.io subdomain is
  // confirmed HTTPS-only forever.
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');

  // The API is never embedded in a frame; DENY is strictly safer than
  // SAMEORIGIN, and `frame-ancestors 'none'` in the CSP below backs
  // this up for browsers that ignore X-Frame-Options.
  res.setHeader('X-Frame-Options', 'DENY');

  // Stops browsers from MIME-sniffing a JSON response into HTML or JS,
  // which would otherwise turn a JSON-injection bug into XSS.
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Origin-only cross-site, full URL same-site.
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // The API server has no reason to advertise camera/mic/geo/etc.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');

  // Explicitly off. Modern browsers ignore it; old IE versions misuse
  // it. "0" tells legacy clients not to engage the broken heuristic.
  res.setHeader('X-XSS-Protection', '0');

  // Prevents third-party origins from embedding our API responses as
  // no-cors resources (`<script src="...">` etc.). API responses are
  // JSON — there's no legitimate cross-origin resource-embedding case.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (HTML_OAUTH_PATH_RE.test(req.path)) {
    // OAuth callback HTML uses an inline <script> that calls
    // window.opener.postMessage(...) plus an inline <style> block.
    // Three relaxations so the popup→opener handoff still works:
    //   - script-src/style-src 'unsafe-inline': the inline blocks
    //     are static + server-generated; no user input is templated
    //     into them. Threading nonces through one-shot HTML responses
    //     is more complexity than the (~tiny) attack surface justifies.
    //   - COOP 'unsafe-none': a 'same-origin' COOP on the popup
    //     would sever window.opener between the popup
    //     (lykn-ideation.onrender.com) and the frontend (lykn.io),
    //     breaking every connector OAuth flow.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none');
  } else {
    // Everywhere else the response is JSON, text, or SSE — the strictest
    // possible CSP is appropriate. Browsers don't render JSON as a
    // document, but the header still helps audit tooling and catches
    // any future HTML response that lands on a non-/oauth path.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  }

  next();
});

const PORT = 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// webEnrichment: ./server/ai/webEnrichment.js

// ✅ MANUAL CORS — strict allowlist
//
// We previously *reflected* unknown origins back into
// `Access-Control-Allow-Origin` while also setting
// `Allow-Credentials: true`. Bearer-token auth (we don't use cookies for
// API auth) keeps the practical CSRF risk low, but reflecting arbitrary
// origins is still a hardening miss: it broadens the set of pages that
// can read API responses against the user's session, and it confuses
// real-world security tooling/audits.
//
// New behavior:
//   1. Exact-match the origin against `ALLOWED_ORIGINS` env (or the
//      built-in defaults below).
//   2. Allow any `localhost` / `127.0.0.1` origin for dev.
//   3. Allow `*.vercel.app` preview origins (we deploy previews there).
//   4. For any other origin: do NOT set `Access-Control-Allow-Origin`.
//      The browser will then refuse the cross-origin request, which is
//      exactly what we want.
//   5. Same-origin / no-Origin requests (curl, server-side, internal
//      health checks) get no CORS header — they don't need one.
const IS_PROD = process.env.NODE_ENV === 'production';

// Production defaults NEVER include localhost — a page on the victim's
// machine at http://localhost:5173 must not be a credentialed CORS caller
// against the prod API. Dev defaults keep the Vite ports. Override either
// via ALLOWED_ORIGINS (comma-separated).
const STATIC_ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : IS_PROD
    ? [
        'https://lykn.io',
        'https://www.lykn.io',
        'https://lykn-ideation.onrender.com',
        'https://www.lykn-ideation.onrender.com',
      ]
    : [
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:5175',
        'https://lykn.io',
        'https://www.lykn.io',
        'https://lykn-ideation.onrender.com',
        'https://www.lykn-ideation.onrender.com',
      ];

// Vercel preview deployments LYKN actually owns. Locked to the exact
// `lykn-ideation-<slug>-elijahlykins-projects.vercel.app` shape Vercel
// emits for our project. We previously accepted every `*.vercel.app`
// origin, which let any Vercel customer's deploy act as a CORS-trusted
// caller against the API; this pattern matches our previews and nothing
// else.
const LYKN_VERCEL_PREVIEW_RE = /^lykn-ideation-[a-z0-9-]+-elijahlykins-projects\.vercel\.app$/;

function isOriginAllowed(origin) {
  if (!origin) return false;
  if (STATIC_ALLOWED_ORIGINS.includes(origin)) return true;
  // Dev-only loopback escape hatch — picks up Vite's automatic port
  // bumping (5174, 5175, …) without needing to keep STATIC_ALLOWED_ORIGINS
  // in sync. Disabled in production: an attacker serving from
  // http://localhost:9999 on a victim's machine should never be able
  // to talk to the prod API through the user's browser.
  if (!IS_PROD && (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'))) {
    return true;
  }
  // Vercel preview deployments — only LYKN's own. See the
  // LYKN_VERCEL_PREVIEW_RE comment above for why this is pinned and
  // not a broad `endsWith('.vercel.app')` check.
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:' && LYKN_VERCEL_PREVIEW_RE.test(url.hostname)) {
      return true;
    }
  } catch {
    /* malformed origin — deny */
  }
  return false;
}

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && isOriginAllowed(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
    // CORS response headers (methods, credentials, allowed request
    // headers, exposed response headers) only mean anything when paired
    // with a matching Access-Control-Allow-Origin. Sending them on
    // rejected origins is at best noise; at worst it confuses scanners.
    // Keep them strictly inside the allow branch.
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Expose-Headers', 'X-Model-Downgraded, X-Plan, X-Feature-Stripped');
    res.header('Access-Control-Allow-Credentials', 'true');
  } else if (origin) {
    // Disallowed cross-origin caller. We deliberately do NOT echo the
    // origin or fall back to `*` — the browser will block the response,
    // which is the correct outcome. We log once so legitimate domains
    // we forgot to allowlist surface during ops review.
    if (!IS_PROD) {
      console.warn(`🔒 CORS: blocked origin ${origin} on ${req.method} ${req.path}`);
    }
  }
  // No-origin requests (same-origin, curl, server-to-server) get no
  // CORS header — they don't need one and don't trigger preflight.

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// ============================================
// STRIPE — client + price map
// ============================================
// NOTE: Stripe must be initialized before the webhook route so the raw-body
// handler can verify signatures.
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// Price IDs live in Stripe, not in code. Map internal plan ids → env-provided
// Stripe price ids. Populate these in .env after creating the corresponding
// Products + Prices in the Stripe dashboard.
const STRIPE_TRIAL_DAYS = Math.max(
  1,
  Number(process.env.STRIPE_TRIAL_DAYS || 7) || 7,
);

/** Checkout copy shown on Stripe's hosted page (supports Markdown). */
function trialCheckoutCustomText(trialDays = STRIPE_TRIAL_DAYS) {
  const days = Math.max(1, Number(trialDays) || STRIPE_TRIAL_DAYS);
  const dayLabel = days === 1 ? '1 day' : `${days} days`;
  return {
    submit: {
      message:
        `**${dayLabel} free — $0 due today.** Start your LYKN trial now; cancel anytime before it ends and you won't be charged.`,
    },
    after_submit: {
      message:
        `Your ${dayLabel} LYKN trial is active. Cancel anytime from LYKN billing settings — no charge if you cancel before the trial ends.`,
    },
  };
}

const STRIPE_PRICE_MAP = {
  student: {
    monthly: process.env.STRIPE_PRICE_STUDENT_MONTHLY,
    annual: process.env.STRIPE_PRICE_STUDENT_ANNUAL,
  },
  studio: {
    // New Pro monthly checkouts. Must be a real $20/month Stripe Price id.
    // Keep the old $25 id in STRIPE_PRICE_STUDIO_MONTHLY_LEGACY for migration.
    monthly: process.env.STRIPE_PRICE_STUDIO_MONTHLY,
    annual: process.env.STRIPE_PRICE_STUDIO_ANNUAL,
  },
  max: {
    monthly: process.env.STRIPE_PRICE_MAX_MONTHLY,
    annual: process.env.STRIPE_PRICE_MAX_ANNUAL,
  },
  studio_pro: {
    monthly: process.env.STRIPE_PRICE_STUDIO_PRO_MONTHLY,
    annual: process.env.STRIPE_PRICE_STUDIO_PRO_ANNUAL,
  },
  studio_max: {
    monthly: process.env.STRIPE_PRICE_STUDIO_MAX_MONTHLY,
    annual: process.env.STRIPE_PRICE_STUDIO_MAX_ANNUAL,
  },
};

// Historical one-time credit packs. New purchases are retired; the map stays
// so delayed Stripe webhooks can still grant a pack that already paid.
// Each pack in CREDIT_PACKS (pricing-config.js) names
// the env var holding its Stripe price id; a pack with no configured price is
// simply not offered, so this ships safely before the Stripe products exist.
// The prices must be ONE-TIME in Stripe — mode: 'payment' checkout rejects
// recurring prices.
const STRIPE_TOPUP_PRICE_MAP = Object.fromEntries(
  CREDIT_PACKS.map((pack) => [pack.id, String(process.env[pack.envVar] || '').trim()]),
);

logStripePriceConfig(process.env);


// COMPED ACCOUNTS: ./server/services/billingService.js


// ============================================
// PERIMETER RATE LIMITING — surfaces the global /api/ limiter never sees
// ============================================
// The global limiter (declared in the RATE LIMITING section below) is mounted
// at '/api/' AFTER these routes register, so every route in this bootstrap
// region — plus everything mounted outside '/api/' (/f/:token, /oauth/*) —
// would otherwise ship with NO rate limit at all. Each such surface gets a
// dedicated IP-keyed limiter here so no endpoint is limiter-free. These are
// declared this early because the webhook/client-error/health registrars run
// before the main RATE LIMITING section exists.
//
// All use the express-rate-limit default key generator (client IP, IPv6-safe;
// truthful behind Render's edge thanks to `trust proxy = 1`).
const perimeterLimiter = (max, message, windowMs = 60 * 1000) => rateLimit({
  windowMs,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: message },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'perimeterLimiter'),
});

// Stripe retries 429s with backoff, so a generous ceiling loses no events
// while capping how fast an attacker can force HMAC verification work.
const stripeWebhookLimiter = perimeterLimiter(120, 'Too many webhook deliveries');
// Render polls every few seconds from one IP (~12-20/min); 120 leaves room
// for uptime monitors without letting the DB-probing handler be hammered.
const healthLimiter = perimeterLimiter(120, 'Too many health checks');
// Crash reports are rare; even a render crash-loop stays under 20/min, and
// this is the only public unauthenticated JSON sink — keep it tight.
const clientErrorLimiter = perimeterLimiter(20, 'Too many error reports');
// Artifact previews can embed several proxied files per page load.
const fileProxyLimiter = perimeterLimiter(120, 'Too many download requests');
// Manual code-edit re-renders from the artifact panel; humans click these.
const artifactRebuildLimiter = perimeterLimiter(20, 'Too many rebuild requests — try again in a minute');
// OAuth redirects/verifies are user-driven and rare per client.
const oauthCallbackLimiter = perimeterLimiter(30, 'Too many OAuth callback requests');

// ============================================
// STRIPE WEBHOOK — must be mounted BEFORE express.json()
// ============================================
// Raw-body route (Wave 7: server/routes/stripeWebhook.routes.js). This call
// MUST stay above the branching JSON parser below — Stripe verifies the HMAC
// signature against the raw request bytes. handleStripeEvent is the hoisted
// billing event processor declared later in this file.
registerStripeWebhook(app, { stripe, handleStripeEvent, webhookLimiter: stripeWebhookLimiter });

// Global JSON body limit. Tightened from the legacy 5mb default to 1mb —
// no TEXT-only route in the surface area legitimately needs more (the
// largest is /api/ai/stream with a fully-loaded workspaceContext +
// conversation + knowledgeBase, which sits in the low-hundred-KB range
// under the AI_BUDGETS truncation; verified by reading the prompt builder).
// 1mb keeps a comfortable headroom for that path while shrinking the
// memory-exhaustion window for every other JSON-accepting route by 5x.
// File-upload routes use multer (multipart) and are unaffected. The
// Stripe webhook is mounted with express.raw above this line and is
// unaffected.
//
// EXCEPTION — image-bearing AI routes. The chat endpoints accept up to 8
// images as base64 data URLs in `imageUrls`. Even after the client
// downscales them, a multi-image turn (or a single high-res phone photo)
// runs to a few MB, well over 1mb. Because express.json runs once and
// reads the stream BEFORE any per-route middleware, a route-level override
// can't *raise* the limit (the global parse would already have 413'd).
// So we branch here: these specific, authenticated + rate-limited routes
// get a larger ceiling; everything else stays at 1mb. (Previously this
// 413'd silently and surfaced to users as a repeated "trouble connecting"
// error whenever they attached an image on mobile.)
const standardJsonParser = express.json({ limit: '1mb' });
const imageJsonParser = express.json({ limit: '12mb' });
const IMAGE_BEARING_AI_ROUTES = new Set([
  '/api/ai/stream',
  '/api/ai/invoke',
  '/api/ai/imagine-image',
  '/api/desktop/browser-plan',
  '/api/desktop/browser-plan-next',
  '/api/desktop/browser-report',
  '/api/desktop/agent-model',
]);
app.use((req, res, next) => {
  if (IMAGE_BEARING_AI_ROUTES.has(req.path)) {
    return imageJsonParser(req, res, next);
  }
  return standardJsonParser(req, res, next);
});

// Mirror the global error handler's prod-vs-dev split for the handful of
// route-local `catch` blocks that return their own 500 (and so never reach
// that handler). In production callers get `fallback` only; in dev they also
// get `err.message` for the console. Never the stack, never the raw message
// in prod — those can carry DB schema names, file paths, or upstream internals.
function safeErr(err, fallback) {
  if (process.env.NODE_ENV === 'production') return fallback;
  return err?.message || fallback;
}

// ============================================
// CLIENT ERROR REPORTING + HEALTH CHECK
// ============================================
// Pre-global-limiter platform routes (Wave 7: preLimiterPlatform.routes.js),
// registered at this exact position — after the branching JSON parser,
// before the auth core below. Both carry their own perimeter limiter (they
// register before the global /api/ limiter mounts, so it never covers them).
// /api/health receives a lazy getter because the supabaseAdmin const is not
// initialized yet at this point in the bootstrap (the handler resolves it
// per request, same as the inline code).
registerClientErrorRoute(app, { clientErrorLimiter });
registerHealthRoute(app, { getSupabaseAdmin: () => supabaseAdmin, healthLimiter });

// ============================================
// AUTH MIDDLEWARE — verify Supabase JWT
// ============================================
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

// Agent 06: wire the security-logger's audit-table sink. Until this call
// lands, security-logger.js degrades to console.error-only — which is the
// correct fallback (dropping a request because the audit table is down
// would be worse than missing the audit row).
setSecurityLoggerSink(supabaseAdmin);
bindChatRetrieval({ supabaseAdmin });
bindChatContext({ supabaseAdmin });
bindVoiceBriefing({ supabaseAdmin });
bindModelSettingsClient(supabaseAdmin);
if (process.env.OPENROUTER_API_KEY) {
  void syncOpenRouterCatalog().catch((err) => {
    console.warn('[models] OpenRouter catalog sync skipped:', err?.message || err);
  });
}
bindVaultEnrichment({ supabaseAdmin });
bindChatToolCtx({ supabaseAdmin });
bindBillingService({
  stripe,
  supabaseAdmin,
  STRIPE_PRICE_MAP,
  STRIPE_TOPUP_PRICE_MAP,
  STRIPE_TRIAL_DAYS,
});


// Agent 06: wire the validation failure hook so every 400 from
// validate() / validateQuery() / validateParams() emits a structured
// VALIDATION_FAILURE event with field names only (never values).
setValidationFailureHook(({ target, fields, req }) => {
  logSecurityEvent(SecurityEvent.VALIDATION_FAILURE, {
    target,            // 'body' | 'query' | 'params'
    fields,            // string[]; never the user-submitted values
  }, { req });
});

// Agent 06: helper for AI-route prompt sanitisation. The three /api/ai/*
// endpoints each sanitise ~7 string fields plus the conversation array.
// We want ONE INJECTION_STRIPPED event per request — not per pattern, not
// per field. This helper bundles the count-tracking sanitisers, sums the
// removed counts, and emits exactly once if any fragments were stripped.
// The event payload contains the COUNT only — never the matched fragments
// — so a log aggregator never receives injection payloads from real
// attempts.
//
// Returns: { fields, turns, removed }
//   fields  - object of sanitised string values keyed by input field name
//   turns   - sanitised turn array (or whatever was passed in)
//   removed - total fragment count across all inputs
function sanitizePromptBundle({ req, fields = {}, turns = null, route = null }) {
  let total = 0;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const { content, removed } = sanitizeUserContentWithCount(v);
    out[k] = content;
    total += removed;
  }
  let outTurns = turns;
  if (turns !== null && turns !== undefined) {
    const { turns: t, removed } = sanitizeTurnArrayWithCount(turns);
    outTurns = t;
    total += removed;
  }
  if (total > 0) {
    logSecurityEvent(SecurityEvent.INJECTION_STRIPPED, {
      matchCount: total,
      route: route || req?.path || null,
      // Field-name presence (NOT values) — useful for spotting which
      // input vector is being targeted (conversation history vs.
      // workspace context vs. fresh prompt).
      fieldsScanned: Object.keys(fields),
      hadConversation: Array.isArray(turns),
    }, { req });
  }
  return { fields: out, turns: outTurns, removed: total };
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn('🔒 requireAuth: missing/invalid Authorization header on', req.method, req.path);
    // Agent 06: structured event for missing-bearer path. Fire-and-forget.
    logSecurityEvent(SecurityEvent.AUTH_MISSING_TOKEN, {}, { req });
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    // Fail-closed in production: a misconfigured deploy (env var lost
    // during a Render redeploy, secret rotation that didn't fan out)
    // should refuse traffic, not silently bypass auth on every route.
    // Local dev keeps the bypass so you can hack on routes without a
    // Supabase project wired up — but with a louder log so it's clear
    // why requests are sailing through.
    if (process.env.NODE_ENV === 'production') {
      console.error('🔒 requireAuth: SUPABASE_URL / SUPABASE_ANON_KEY missing in production — refusing request');
      // Agent 06: this is a CRITICAL alert candidate — Agent 02's M2
      // fail-closed branch should never fire in steady state. Wiring an
      // event here means a misconfigured production deploy pages the
      // on-call as soon as the next request lands.
      logSecurityEvent(SecurityEvent.AUTH_CONFIG_MISSING, {
        missing: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'].filter((k) => !process.env[k === 'SUPABASE_URL' ? 'VITE_SUPABASE_URL' : 'VITE_SUPABASE_ANON_KEY']),
      }, { req });
      return res.status(503).json({ error: 'Authentication service not configured' });
    }
    console.warn('🔒 requireAuth: SUPABASE_URL / SUPABASE_ANON_KEY missing — allowing request (DEV FALLBACK ONLY)');
    return next();
  }
  try {
    const token = authHeader.slice(7);
    // Verify against Supabase with a timeout + small retry. A transient network
    // blip (socket hang up, brief DNS hiccup) used to throw and surface to the
    // user as "Auth verification failed" — retrying once or twice rides out the
    // blip. We only retry on a THROWN network error, never on an HTTP response
    // (a 401 is a real answer and returns immediately).
    let resp = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      try {
        resp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY },
          signal: ctrl.signal,
        });
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    if (!resp) throw lastErr || new Error('supabase_unreachable');
    if (!resp.ok) {
      const bodyPreview = await resp.text().catch(() => '');
      console.warn('🔒 requireAuth: Supabase rejected token', { status: resp.status, path: req.path, body: bodyPreview.slice(0, 300) });
      // Agent 06: distinguish 401 (invalid/expired) from missing-token
      // so alert rules can fire on credential-stuffing patterns
      // separately from "client forgot the header".
      logSecurityEvent(SecurityEvent.AUTH_FAILURE, {
        reason: resp.status === 401 ? 'invalid_or_expired_token' : `supabase_${resp.status}`,
        tokenPrefix: tokenPrefix(token),
      }, { req });
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const user = await resp.json();
    req.user = user;
    next();
  } catch (err) {
    console.error('🔒 requireAuth: fetch to Supabase threw', { name: err?.name, message: err?.message, cause: err?.cause?.code || err?.cause?.message, path: req.path });
    logSecurityEvent(SecurityEvent.AUTH_FAILURE, {
      reason: 'supabase_fetch_threw',
      errName: err?.name || null,
    }, { req });
    return res.status(503).json({ error: 'Auth verification failed' });
  }
}

// Make the service-role Supabase client available to the per-request tool
// context builders without re-importing it. `app.get(...)` is the express
// idiom for sharing instance-level deps.
app.set('supabaseAdmin', supabaseAdmin);

// ============================================
// FILE DOWNLOAD PROXY + ARTIFACT REBUILD
// ============================================
// /f/:token and /api/artifacts/react/rebuild (Wave 7:
// preLimiterPlatform.routes.js), registered at this exact position — after
// the auth core, BEFORE the global /api/ limiter. Both carry dedicated
// perimeter limiters (closes the former rate-limit-exemption finding).
registerFileProxyAndArtifactRoutes(app, {
  supabaseAdmin,
  requireAuth,
  fileProxyLimiter,
  artifactRebuildLimiter,
});

// ============================================
// ADMIN GATE — restrict /api/admin/* to allowlisted email(s)
// ============================================
// Configure via ADMIN_EMAILS env (comma-separated). NO default — an empty
// allowlist means every /api/admin/* request is denied. validateSecrets()
// makes ADMIN_EMAILS mandatory in production, so this is only ever empty in a
// misconfigured dev box, where failing closed is the safe behavior. (A baked-in
// default like admin@lykn.io would grant admin to whoever registers that email.)
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function requireAdmin(req, res, next) {
  const email = String(req.user?.email || '').toLowerCase();
  if (ADMIN_EMAILS.length === 0) {
    console.warn('🔒 requireAdmin: blocked — ADMIN_EMAILS not configured', { path: req.path });
    return res.status(403).json({ error: 'Admin only' });
  }
  if (!email || !ADMIN_EMAILS.includes(email)) {
    console.warn('🔒 requireAdmin: blocked', { email: email || '(none)', path: req.path });
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

/**
 * Phase 2 Chat personal-memory seam. Migrates trustworthy legacy facts
 * once, then resolves L0/L1/L2 through MemoryResolver. Fail-soft: a
 * memory error must never fail the turn.
 */
async function resolveProductionChatMemory({ userId, user, chatId, skip, recall, deepen }) {
  if (skip || !userId) return { text: '', metrics: null };
  const store = getMemoryStore(supabaseAdmin);
  if (!store) return { text: '', metrics: null };
  try {
    await ensureLegacyMemoryMigrated(store, userId, {
      client: supabaseAdmin,
      displayName: pickUserDisplayName(user),
    });
    const turn = await resolveChatMemoryTurn(store, userId, { chatId, recall, deepen });
    if (turn.metrics) {
      console.log(
        `🧠 memory: l0=${turn.metrics.l0Tokens} registry=${turn.metrics.registryTokens} ` +
          `docs=${turn.metrics.documentCount} deep=${turn.metrics.deepDocuments} ` +
          `tokens=${turn.metrics.totalTokens}`,
      );
    }
    return turn;
  } catch (e) {
    console.warn('⚠️ memory resolve:', e?.message || e);
    return { text: '', metrics: null };
  }
}

// userIdentity: ./server/ai/userIdentity.js


// voiceBriefing: ./server/ai/voiceBriefing.js

// ============================================
// RATE LIMITING
// ============================================
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down' },
  // Agent 06: emit RATE_LIMIT_HIT on every per-key window exhaustion.
  // Preserves the original 429 + JSON body.
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'globalLimiter'),
});

const userOrIpKey = (req) => req.user?.id || req.ip;

const rlValidateOff = { keyGeneratorIpFallback: false };

// ─── Credential tier ─────────────────────────────────────────────────────
//
// `authLimiter` covers the credential-equivalent auth endpoints — signup
// start / resend / verify, password-reset start / confirm, and the Apple
// token exchange. All are reachable from the public internet, so without a
// ceiling they are brute-forceable (OTP guessing, reset-token fishing) and
// a signup-flood vector.
//
// Keyed on req.ip — Agent 01's `app.set('trust proxy', 1)` makes that
// truthful behind Render's edge.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: rlValidateOff,
  message: { error: 'Too many authentication attempts. Try again later.' },
  // Agent 06: RATE_LIMIT_AUTH is the dedicated high-severity event for
  // OAuth credential-mint brute-force signals.
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_AUTH, 'authLimiter'),
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  validate: rlValidateOff,
  message: { error: 'AI rate limit exceeded — try again in a minute' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'aiLimiter'),
});

// Tighter burst cap for media / session mint endpoints (TTS, Whisper,
// realtime, ElevenLabs). Stacks on top of aiLimiter (30/min).
const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  validate: rlValidateOff,
  message: { error: 'Generation rate limit exceeded — try again in a minute' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'generationLimiter'),
});

// Authenticated search / scrape / YouTube helpers burn third-party quota.
// Tighter than globalLimiter so a single user can't drain CSE/Serper.
const searchScrapeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  validate: rlValidateOff,
  message: { error: 'Search/scrape rate limit exceeded — try again in a minute' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'searchScrapeLimiter'),
});

// ElevenLabs custom-LLM proxy — shared-secret auth, but still rate-limit so a
// leaked ELEVENLABS_LLM_SECRET can't torch the OpenAI bill uncapped.
const elevenLlmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: rlValidateOff,
  message: { error: 'ElevenLabs LLM rate limit exceeded' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'elevenLlmLimiter'),
});

const describeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  validate: rlValidateOff,
  message: { error: 'Describe rate limit exceeded — try again in a minute' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'describeLimiter'),
});

// Studio Imagine (Midjourney-style) fires one request per image, 4 per
// batch — 24/min allows a few quick batches without letting a runaway
// client hammer the image providers.
const imagineLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 24,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  validate: rlValidateOff,
  message: { error: 'Image rate limit exceeded — try again in a minute' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'imagineLimiter'),
});

const synthesisLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 24,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  validate: rlValidateOff,
  message: { error: 'Synthesis reindex rate limit — try again shortly' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'synthesisLimiter'),
});

// Guest (unauthenticated) AI limiter — keyed strictly by IP.
// Tight ceiling to keep the free landing experience cheap + abuse-resistant.
// The three windows (per-minute / per-hour / per-day) stack so a single IP
// can't burn the whole day's budget in one burst, can't trickle past the
// hourly window, and can't slow-drip past the daily ceiling.
const guestAiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: rlValidateOff,
  message: { error: 'Guest rate limit — sign in for higher limits' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'guestAiLimiter'),
});

const guestAiHourlyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: rlValidateOff,
  message: { error: 'Guest hourly limit reached — sign in to keep chatting' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'guestAiHourlyLimiter'),
});

const guestAiDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  validate: rlValidateOff,
  message: { error: 'Daily guest limit reached — sign in to keep chatting' },
  handler: buildRateLimitHandler(SecurityEvent.RATE_LIMIT_HIT, 'guestAiDailyLimiter'),
});

// Server-wide guest ceiling. In-memory rolling hour counter to act as
// a kill switch if the demo gets dogpiled (e.g. shared on social) so
// the entire LLM bill can't be torched by anonymous traffic. Resets
// every 60 minutes. Tune via env var GUEST_AI_GLOBAL_HOURLY_MAX.
const GUEST_AI_GLOBAL_HOURLY_MAX = Math.max(
  100,
  parseInt(process.env.GUEST_AI_GLOBAL_HOURLY_MAX || '4000', 10) || 4000,
);
let guestAiGlobalHourlyCount = 0;
let guestAiGlobalHourlyResetAt = Date.now() + 60 * 60 * 1000;
const guestAiGlobalLimiter = (req, res, next) => {
  const now = Date.now();
  if (now >= guestAiGlobalHourlyResetAt) {
    guestAiGlobalHourlyCount = 0;
    guestAiGlobalHourlyResetAt = now + 60 * 60 * 1000;
  }
  if (guestAiGlobalHourlyCount >= GUEST_AI_GLOBAL_HOURLY_MAX) {
    return res.status(503).json({
      error: 'Guest demo is temporarily over capacity — please sign in or try again later.',
    });
  }
  guestAiGlobalHourlyCount += 1;
  next();
};

app.use('/api/', globalLimiter);

// The OAuth callback/verify pages (/oauth/calendar/google/callback,
// /oauth/connections/*, /oauth/mcp/*) are deliberately mounted OUTSIDE
// '/api/' so the global limiter above never matches them. This mount closes
// that gap — every non-/api OAuth surface registered below passes through
// the perimeter limiter declared alongside the webhook/health limiters.
app.use('/oauth/', oauthCallbackLimiter);

// Metered-usage gate — replaces the retired monthly glass-request quota.
// There are no per-feature request caps anymore: included chat is free for
// paid plans, everything else meters the dollar Usage Balance.
//
//   • Chat paths: paid plans pass (included chat); free-tier chat is metered
//     but requireAppAccess has already verified a positive balance. Premium
//     manual-model checks happen inside the chat route, where the requested
//     model is known.
//   • Non-chat compute (TTS, transcription, describe, …): metered for every
//     plan — requires a positive Usage Balance, or leftover legacy credits
//     until the migration converts them.
async function checkAiUsageLimit(req, res, next) {
  try {
    const userId = req.user?.id;
    if (!userId) return next();
    // Local/dev without a service role has no billing backend; skip the gate.
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return next();

    const isChatPath = CHAT_USAGE_GATE_PATHS.includes(String(req.path || ''));
    if (isChatPath) {
      markTopupPayer(userId, false);
      return next();
    }

    const usage = await getUsageBalance(userId);
    if ((usage?.available || 0) > 0) {
      markTopupPayer(userId, false);
      return next();
    }
    // The wallet read fails closed — a DB blip must not bypass billing.
    const wallet = await getCreditWallet(userId);
    if (wallet === null) {
      return res.status(503).json({
        error: 'usage_check_unavailable',
        message: 'Could not verify your usage right now. Please try again.',
      });
    }
    if (wallet.balance > 0) {
      markTopupPayer(userId, true);
      return next();
    }
    markTopupPayer(userId, false);
    return res.status(402).json({
      error: 'insufficient_usage_balance',
      message: 'This action uses your usage balance. Top up to continue.',
      add_funds: true,
    });
  } catch (err) {
    console.error('⚠️ AI usage check failed, refusing request:', err.message);
    return res.status(503).json({
      error: 'usage_check_unavailable',
      message: 'Could not verify your usage right now. Please try again.',
    });
  }
}

// ============================================
// SSRF PROTECTION — block private/internal IPs
// ============================================
// Backed by the shared ssrfGuard, which resolves the hostname via DNS and
// rejects the RESOLVED IP if it is loopback/private/link-local/CGNAT — so
// decimal/octal/hex IP encodings, raw IPv6 literals, and DNS-rebinding are all
// caught (the old string-prefix check missed 127.0.0.2, 2130706433, [::ffff:…],
// and any public name pointing at a private address). Async because it does a
// DNS lookup; every caller is inside an async route handler. For the actual
// fetch, prefer safeFetch() which re-validates each redirect hop.
async function isUrlSafe(urlString) {
  const result = await assertUrlSafe(urlString);
  return result.ok;
}

// ============================================
// UNHANDLED REJECTION SAFETY NET
// ============================================
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled promise rejection:', reason);
});

registerAiModelsRoute(app);
registerAiGuestStreamRoute(app, { guestAiGlobalLimiter, guestAiLimiter, guestAiHourlyLimiter, guestAiDailyLimiter });

// Legacy-named vault retrieval index routes.
registerSynthesisRoutes(app, {
  requireAuth,
  requireAppAccess,
  synthesisLimiter,
  supabaseAdmin,
  createSynthesisUserClient,
  deleteSynthesisChunksForSource,
  replaceSynthesisChunks,
});

// ── Account — extracted to server/routes/account.routes.js (Wave 4)
// 7 routes (preferences GET/PATCH, night-shift briefs, steward items
// GET/POST/PATCH, DELETE /api/account) register here, in their original
// order.
registerAccountRoutes(app, {
  requireAuth,
  supabaseAdmin,
  stripe,
});

// ── Sign in with Apple token exchange — extracted to
// server/routes/authFlows.routes.js (Wave 5)
registerAppleAuthRoutes(app, { requireAuth, authLimiter, supabaseAdmin });

// ── Client metrics ingest — extracted to
// server/routes/platform.routes.js (Wave 5)
registerMetricsRoutes(app, { requireAuth, supabaseAdmin });

registerAiFeedbackRoute(app, { requireAuth, supabaseAdmin });

// ── Custom connections — extracted to server/routes/connections.routes.js (Wave 2)
// 5 routes register here, in their original order.
registerCustomConnectionsRoutes(app, { requireAuth, supabaseAdmin, invalidateConnectedToolsCache });
registerCalendarConnectionRoutes(app, { requireAuth, supabaseAdmin, PORT });
registerCursorCredentialRoutes(app, { requireAuth, supabaseAdmin });
// ── Managed connected accounts (Gmail via Composio) — LYKN Connection Service
registerConnectionServiceRoutes(app, { requireAuth, supabaseAdmin, PORT });
registerMcpRoutes(app, { requireAuth, supabaseAdmin, PORT });

registerCustomModelRoutes(app, { requireAuth, supabaseAdmin });

// ── Synthesis maintenance — extracted to server/routes/synthesis.routes.js (Wave 2)
// 3 routes (/api/vault/enrich-note, /api/vault/reconcile, /api/synthesis/backfill)
// register here, in their original order. The helper definitions that used to
// sit between them were not registrations, so stack order is unchanged.
registerSynthesisMaintenanceRoutes(app, {
  requireAuth,
  requireAppAccess,
  synthesisLimiter,
  supabaseAdmin,
  createSynthesisUserClient,
  safeErr,
  enrichVaultNoteSummary,
  backfillVaultText,
  replaceSynthesisChunks,
});





registerAiInvokeRoute(app, { requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit, sanitizePromptBundle, resolveProductionChatMemory });
registerAiStreamRoutes(app, { requireAuth, requireAppAccess, aiLimiter, checkAiUsageLimit, supabaseAdmin, sanitizePromptBundle, resolveProductionChatMemory });

// Short TTL — these URLs are bearer-equivalent. The client refreshes on
// demand via `signedUrlCacheRef` (Vault) / per-component caches, so a long
// TTL only widens the leak window from logs/screenshots/shared links.
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1 hour

// ── Storage / vault utilities — extracted to
// server/routes/storage.routes.js (Wave 4). 4 routes (ai/vault-search,
// storage/signed-url, storage/file-proxy-url, vault/backfill-descriptions)
// register here, in their original order.
registerStorageRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  describeLimiter,
  supabaseAdmin,
  sha256,
  SIGNED_URL_TTL_SECONDS,
  OUTPUT_CAPS,
  enrichVaultNoteSummary,
  backfillVaultText,
  findAttachmentsMarkerSpan,
  extractBodyAfterAttachmentsMarker,
  replaceSynthesisChunks,
  createSynthesisUserClient,
});

// ── AI assist / media utilities — extracted to
// server/routes/assist.routes.js (Wave 4). 10 routes (imagine-image,
// describe-image, transcribe, meeting-chunk, summarize-conversation,
// clean-transcript, live-assist, meeting-notes, suggest, name-grid)
// register here, in their original order.
registerAssistRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  generationLimiter,
  imagineLimiter,
  describeLimiter,
  checkAiUsageLimit,
  upload,
  supabaseAdmin,
  memCache,
  sha256,
});

// ── Desktop / Glass browser agent — extracted to server/routes/desktop.routes.js (Wave 3)
// 9 routes (agent-intent, browser-plan, agent-model, agent-ground,
// browser-plan-next, browser-report, desktop chats GET+save, ai/name-chat)
// register here, in their original order.
registerDesktopRoutes(app, {
  requireAuth,
  requireAppAccess,
  requireMeteredUsage: checkAiUsageLimit,
  aiLimiter,
  supabaseAdmin,
  sha256,
  memCache,
});

// ── Voice — extracted to server/routes/voice.routes.js (Wave 3)
// 11 routes (tts, realtime session/tool/screen, tune-instructions,
// elevenlabs signed-url/voices, the custom-LLM proxy at 3 alias paths, and
// its _debug endpoint) register here, in their original order. The helper
// trio below (currentTimeContextLine / localTimeContextLine /
// buildRealtimeMemoryGrounding) stays: the chat path uses
// localTimeContextLine, while the grounding builder provides Markdown Memory
// and retained project/conversation context.
registerVoiceRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  generationLimiter,
  checkAiUsageLimit,
  elevenLlmLimiter,
  supabaseAdmin,
  memCache,
  sha256,
  safeErr,
  timingSafeEqualStr,
  buildRealtimeMemoryGrounding,
  currentTimeContextLine,
  localTimeContextLine,
  buildToolCtx,
  PROJECT_WRITE_TOOLS,
  invalidateProjectSectionCache,
  fetchProjectSection,
  gatherVoiceBriefingData,
  formatVoiceBriefingInstructionBlock,
  buildVoiceBriefingOffer,
});

// timeContext: ./server/ai/timeContext.js


/**
 * Build Markdown Memory plus active project context for realtime voice.
 */
async function buildRealtimeMemoryGrounding(authHeader, userId) {
  if (!userId) return '';
  const sections = [];
  try {
    const [projectSection, memoryTurn] = await Promise.all([
      fetchProjectSection(authHeader, userId).catch(() => ({ text: '' })),
      resolveProductionChatMemory({ userId, skip: false }).catch(() => ({ text: '' })),
    ]);
    if (memoryTurn?.text) sections.push(memoryTurn.text);
    if (projectSection?.text) sections.push(projectSection.text);
  } catch (e) {
    console.warn('⚠️ buildRealtimeMemoryGrounding:', e?.message || e);
  }
  // Custom-model sub-agent roster soft-unplugged from voice.
  if (CUSTOM_MODELS_ENABLED) {
    try {
      if (supabaseAdmin) {
        const roster = await loadPublishedRoster(supabaseAdmin, userId, { limit: 16 });
        const block = formatDefaultMainAgentBlock(roster, { voice: true });
        if (block) sections.push(block);
      }
    } catch (e) {
      console.warn('⚠️ voice main-agent roster:', e?.message || e);
    }
  }
  // Past conversations: the text chat injects [CONVERSATION_MEMORY] from the
  // client, but voice's client grounding only carries the CURRENT session — so
  // without this the voice agent genuinely can't see anything said in earlier
  // sessions and tells the user it has no memory of them. Pull recent exchanges
  // server-side via admin (no user JWT reaches the custom-LLM endpoint) so voice
  // has the same recall the written chat does.
  try {
    if (supabaseAdmin) {
      const { data: memRows } = await supabaseAdmin
        .from('ai_conversation_memory')
        .select('user_message, assistant_message, surface, surface_title, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(12);
      const exchanges = (memRows || []).slice().reverse();
      let memText = '';
      for (const ex of exchanges) {
        const label = ex.surface_title ? `${ex.surface} "${ex.surface_title}"` : String(ex.surface || 'chat');
        memText += `--- (${label}) ---\nUser: ${String(ex.user_message || '').slice(0, 600)}\nAssistant: ${String(ex.assistant_message || '').slice(0, 600)}\n\n`;
      }
      memText = memText.trim();
      if (memText) {
        sections.push(
          `[CONVERSATION_MEMORY — past exchanges from earlier sessions/projects/vault; reference them when relevant]\n${sanitizeStaleSurfaceLanguage(memText.slice(0, 4000))}`,
        );
      }
    }
  } catch (e) {
    console.warn('⚠️ voice conversation memory:', e?.message || e);
  }
  return sections.join('\n\n');
}

// YouTube + Whisper endpoints — extracted to
// server/routes/youtube.routes.js (Wave 1). 8 routes register here, in
// their original order.
registerYouTubeRoutes(app, {
  requireAuth,
  requireAppAccess,
  aiLimiter,
  searchScrapeLimiter,
  upload,
  supabaseAdmin,
  sha256,
});

// Web search / scrape / unfurl — extracted to
// server/routes/webtools.routes.js (Wave 1). 3 routes register here, in
// their original order.
registerWebtoolsRoutes(app, {
  requireAuth,
  searchScrapeLimiter,
  isUrlSafe,
});


// ── Files — extracted to server/routes/files.routes.js (Wave 3)
// 6 routes (extract-text, parse-spreadsheet, vault save-image/save-file,
// files process/search) register here, in their original order.
registerFilesRoutes(app, {
  requireAuth,
  upload,
  supabaseAdmin,
  safeErr,
  indexVaultNoteForSearch,
  SIGNED_URL_TTL_SECONDS,
});

// ============================================
// FEEDBACK / EMAIL AUTH / PROJECT INVITE — extracted (Wave 5)
// ============================================
// resendClient + findAuthUserByEmail stay here: both are shared by the
// feedback, email-auth, and project-invite registrars below (single
// Resend client instance, single admin lookup helper).
const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Find an auth user by email via the admin API. listUsers has no email
// filter, so page through (bounded — fine at current user counts; replace
// with an RPC against auth.users if the user base outgrows this).
async function findAuthUserByEmail(email) {
  const want = String(email || '').trim().toLowerCase();
  if (!want || typeof supabaseAdmin.auth?.admin?.listUsers !== 'function') return null;
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return null;
    const users = data?.users || [];
    const hit = users.find((u) => String(u.email || '').toLowerCase() === want);
    if (hit) return hit;
    if (users.length < 1000) return null; // last page
  }
  return null;
}

// ── Feedback — extracted to server/routes/platform.routes.js (Wave 5)
registerFeedbackRoutes(app, {
  requireAuth,
  resendClient,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
});

// ── Email signup + password reset — extracted to
// server/routes/authFlows.routes.js (Wave 5)
registerEmailAuthRoutes(app, {
  authLimiter,
  supabaseAdmin,
  resendClient,
  findAuthUserByEmail,
});

// ── Project invite — extracted to server/routes/platform.routes.js (Wave 5)
registerProjectInviteRoutes(app, {
  requireAuth,
  supabaseAdmin,
  resendClient,
  findAuthUserByEmail,
  pickUserDisplayName,
});

// ── Usage Tracking API — extracted to server/routes/usage.routes.js (Wave 1)
// 3 routes register here, in their original order.
registerUsageRoutes(app, { requireAuth });
registerModelPlatformRoutes(app, { requireAuth });

// ── Admin dashboards — extracted to server/routes/admin.routes.js (Wave 2)
// 9 routes register here, in their original order.
registerAdminRoutes(app, {
  requireAuth,
  requireAdmin,
  supabaseAdmin,
  stripe,
  STRIPE_TRIAL_DAYS,
  safeErr,
});

// ─────────────────────────────────────────────────────────────────────────────

registerBillingRoutes(app, {
  requireAuth,
  stripe,
  supabaseAdmin,
  stripeConfigured,
  loadBillingRow,
  appUrlFromReq,
  billingMePayload,
  hasSubscriptionAccess,
  hasAppAccessRow,
  hasEstablishedStripeCustomer,
  resolveUserPlan,
  buildStripeCheckoutIdentity,
  rejectIneligibleStudentCheckout,
  isCompedProEmail,
  COMPED_PRO_PLAN_ID,
  PLAN_IDS,
  BILLING_PERIODS,
  PLAN_LIMITS,
  creditPackById,
  availableCreditPacks,
  STRIPE_PRICE_MAP,
  STRIPE_TOPUP_PRICE_MAP,
  STRIPE_TRIAL_DAYS,
  trialCheckoutCustomText,
});

// ============================================
// RSS / ATOM FEEDS — extracted to server/routes/feeds.routes.js (Wave 1)
// ============================================
// 9 routes (feeds CRUD/discover/refresh + the secret-gated poll-due cron
// trio) register here, in their original order. The in-process pollers are
// NOT part of the router — they still start from the app.listen callback.
registerFeedsRoutes(app, {
  requireAuth,
  supabaseAdmin,
  isUrlSafe,
});

// Universal MCP, calendar connections, and Cursor credentials register
// above with custom connections. Legacy connector-OAuth / Vault-sync
// routes are retired.

// ─────────────────────────────────────────────────────────────────────────────

// ============================================
// GLOBAL ERROR HANDLER (Agent 04)
// ============================================
// MUST be the LAST middleware registered. Express only routes errors to
// 4-arg `(err, req, res, next)` middleware that comes AFTER every route in
// the registration order — anything past this point that registers a new
// route would silently bypass error handling for that route.
//
// THIS HANDLER MUST STAY BELOW:
//   • Every app.<method>(...) call in this file (MCP/calendar/cursor
//     connection routes register with custom connections, before feeds).
//     Agent 06 added `app.get('/api/health', ...)` near the top + the
//     `app.get('/api/admin/security/audit', ...)` endpoint earlier in
//     the admin section — both registered BEFORE this handler).
//   • Every app.use(...) middleware mount.
//
// And MUST stay ABOVE app.listen(...) — handlers added inside the
// app.listen callback would still come after this in registration order
// (the callback only registers cron pollers, no routes — verified).
//
// DO NOT add new routes below this point. If a future change needs a new
// route, register it ABOVE this block.
//
// CIA: Confidentiality (no stack/internal leakage in prod). Principle: SbD, LP.
app.use((err, req, res, next) => {
  // SSE / streamed responses may already have written headers and partial
  // body bytes by the time something throws. We can't change the status
  // code at that point — the only safe move is to forward to Express's
  // default close-the-socket behavior.
  if (res.headersSent) return next(err);

  // body-parser oversized-payload errors get a stable, recognisable code.
  const isPayloadTooLarge =
    err?.type === 'entity.too.large' || err?.status === 413 || err?.statusCode === 413;
  const status = isPayloadTooLarge
    ? 413
    : Number.isInteger(err?.statusCode) ? err.statusCode
    : Number.isInteger(err?.status) ? err.status
    : 500;

  // Always log full diagnostic context server-side. (Agent 04's original
  // structured-log line. Kept verbatim for backwards compatibility with any
  // log-aggregation rule that already parses '[ERROR]' lines.)
  console.error('[ERROR]', {
    path: req.path,
    method: req.method,
    userId: req.user?.id,
    status,
    message: err?.message,
    stack: err?.stack,
  });

  // Agent 06: ADDITIVE structured security event. The console.error above
  // is the dev-friendly form; this is the queryable form for the audit
  // table + Render log drain. NEVER includes err.stack (always too noisy
  // to ship to a SIEM) and never includes err.message in production
  // payloads (may contain DB schema names, file paths, library internals).
  const isClientError = status >= 400 && status < 500;
  logSecurityEvent(SecurityEvent.UNHANDLED_ERROR, {
    statusCode: status,
    errorCode: err?.code || null,
    errName: err?.name || null,
    // Message is safe in dev only; matches the prod-vs-dev split below.
    errMessage: process.env.NODE_ENV === 'production' ? null : (err?.message?.slice(0, 500) || null),
    isClientError,
  }, { req });

  if (process.env.NODE_ENV === 'production') {
    // In production: user-safe copy only — never leak err.message, err.stack,
    // or stable internal codes to the wire.
    const userMsg = isPayloadTooLarge
      ? "That upload is too large — try a smaller file."
      : AI_TEMPORARY_FAILURE_TEXT;
    return res.status(status).json({ error: userMsg });
  }

  // In development: include err.message (helpful for the dev console)
  // but still no stack — even in dev, stack frames in HTTP responses are
  // a habit best avoided.
  return res.status(status).json({
    error: err?.message || 'request_failed',
    code: isPayloadTooLarge ? 'payload_too_large' : undefined,
  });
});

// In production (Render), HOST must default to 0.0.0.0 so the platform's
// edge proxy can reach the container. In local dev, bind to loopback
// only — keeps the dev server (which holds dev secrets and an unauthed
// admin stub) off every device on the same WiFi. Override with
// HOST=0.0.0.0 if you actually need to hit dev from another device.
const HOST = process.env.HOST || (IS_PROD ? '0.0.0.0' : '127.0.0.1');
const frontendUrl = process.env.FRONTEND_URL || 'https://lykn.io';

export { app, enrichVaultNoteSummary };

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, HOST, () => {
    console.log(`✅ AI server running on ${HOST}:${PORT}`);
    console.log(`→ Accepting requests from: ${frontendUrl}`);
    if (!IS_PROD) {
      console.log(`→ Also accepting from: http://localhost:5173 (development)`);
    }
    console.log(`→ YouTube API: ${process.env.YOUTUBE_API_KEY ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`→ Pinterest: ${process.env.PINTEREST_CLIENT_ID ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`→ Instagram: ${process.env.INSTAGRAM_CLIENT_ID ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`→ Meta oEmbed (IG/FB): ${process.env.META_APP_TOKEN ? '✅ Enabled' : '⚪ Disabled (set META_APP_TOKEN)'}`);
    console.log(`→ TikTok oEmbed: ✅ Enabled (public API)`);
    console.log(`→ AI Models:`);
    console.log(`   - OpenAI: ${process.env.OPENAI_API_KEY ? '✅' : '❌'}`);
    console.log(`   - Anthropic: ${process.env.ANTHROPIC_API_KEY ? '✅' : '❌'}`);
    console.log(`   - Google Gemini: ${process.env.GOOGLE_API_KEY ? '✅' : '❌'}`);
    console.log(`   - xAI Grok: ${process.env.XAI_API_KEY ? '✅' : '❌'}`);
    startSessionCleanup();

    // RSS poller — defaults ON for any long-running process (Render,
    // local dev, self-hosted). Defaults OFF on serverless (Vercel,
    // AWS Lambda, etc.) where setInterval doesn't survive between
    // requests. On serverless, set up a 1-minute cron to hit
    //   POST /api/feeds/poll-due
    // with `Authorization: Bearer ${ADMIN_INGEST_SECRET}`.
    //
    // Override either way:
    //   RSS_POLLER_ENABLED=1   → force on
    //   RSS_POLLER_ENABLED=0   → force off
    const isServerless =
      process.env.VERCEL === '1' ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.NETLIFY === 'true';
    const explicitRssToggle = process.env.RSS_POLLER_ENABLED;
    const rssPollerOn =
      explicitRssToggle === '1' || explicitRssToggle === 'true'
        ? true
        : explicitRssToggle === '0' || explicitRssToggle === 'false'
          ? false
          : !isServerless;
    if (rssPollerOn && supabaseAdmin) {
      const intervalMs = Math.max(15_000, Number(process.env.RSS_POLLER_INTERVAL_MS) || 60_000);
      const poller = makeRssPoller({ supabaseAdmin, intervalMs });
      poller.start();
    } else {
      console.log('→ RSS poller: ⚪ disabled (set RSS_POLLER_ENABLED=1 to enable)');
    }

    const explicitCalendarToggle = process.env.CALENDAR_POLLER_ENABLED;
    const calendarPollerOn =
      explicitCalendarToggle === '1' || explicitCalendarToggle === 'true'
        ? true
        : explicitCalendarToggle === '0' || explicitCalendarToggle === 'false'
          ? false
          : !isServerless;
    if (calendarPollerOn && supabaseAdmin) {
      const intervalMs = Math.max(
        15_000,
        Number(process.env.CALENDAR_POLLER_INTERVAL_MS) || 60_000,
      );
      const calendarTick = () => {
        pollDueCalendarConnections(supabaseAdmin)
          .catch((error) => console.warn('⚠️ calendar poller:', error?.message || error));
      };
      setTimeout(calendarTick, 9_000);
      setInterval(calendarTick, intervalMs);
    } else {
      console.log(
        '→ Calendar poller: ⚪ disabled (set CALENDAR_POLLER_ENABLED=1 to enable)',
      );
    }

    // Cursor build poller — checks in-flight Cursor cloud-agent builds for
    // completion, records the PR + result, and leaves them unannounced so the
    // next voice briefing tells the user. Same serverless rules as above; on
    // serverless, schedule a cron against POST /api/ai/cursor-builds/poll-due.
    if (!isServerless && supabaseAdmin && isCursorBuildsConfigured()) {
      const intervalMs = Math.max(10_000, Number(process.env.CURSOR_BUILD_POLL_MS) || 30_000);
      const tick = () => {
        pollRunningBuilds(supabaseAdmin)
          .then((r) => {
            if (r?.completed) console.log(`🛠️  Cursor builds: ${r.completed} finished (scanned ${r.scanned})`);
          })
          .catch((e) => console.warn('⚠️ cursor build poller:', e?.message || e));
      };
      setInterval(tick, intervalMs).unref?.();
      console.log(`→ Cursor build poller: ✅ every ${Math.round(intervalMs / 1000)}s`);
    } else if (!isCursorBuildsConfigured()) {
      console.log('→ Cursor build poller: ⚪ disabled (set CONNECTOR_TOKEN_KEY to enable; unset CURSOR_BUILDS_DISABLED. Builds run on each user\'s own connected Cursor account.)');
    }

    if (!process.env.CONNECTOR_TOKEN_KEY) {
      console.log(
        '   ⚠️  CONNECTOR_TOKEN_KEY missing. Generate with: openssl rand -hex 32',
      );
    }
  });
}
