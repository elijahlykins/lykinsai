// ============================================================================
// server/routes/voice.routes.js — TTS, realtime voice, ElevenLabs integration
// ============================================================================
// Extracted verbatim from server.js (Wave 3 of the server decomposition).
// Handler bodies are unchanged; only the registration moved. Paths, methods,
// middleware chains, and registration order are preserved exactly —
// tests/server/serverRouteManifest.test.mjs enforces this.
//
// EXTERNAL API CONTRACT: the ElevenLabs custom-LLM proxy (elevenCustomLlmHandler,
// registered at three alias paths + /_debug) is consumed by ElevenLabs servers
// and must stay OpenAI-compatible with byte-identical streaming behavior.
//
// All voice-exclusive mutable state (voiceSessionGrounding / voiceScreenByUser
// Maps, customLlmStats, lastCustomLlmError, the tts + elevenlabs-voices
// memCaches, VOICE_SESSION_SECRET) lives inside the registrar closure, which
// server.js calls exactly once after dotenv/secret validation — same single
// instance and same init timing as the old inline declarations.
//
// buildRealtimeMemoryGrounding + currentTimeContextLine +
// localTimeContextLine stay in server.js and are passed in:
// localTimeContextLine is also used by the chat prompt path, and the
// grounding builder sits on synthesis retrieval infrastructure
// (LEGACY CANDIDATE — pending Memory Architecture Replacement).

import { searchWeb } from '../../lib/exterior/webSearch.js';
import { communicateWithModelTool } from '../../mcp-tools/communicateWithModel.js';
import { lastUserTextFromMessages, LYKN_VOICE_TOOL_MCP } from '../../mcp-tools/voiceTools.js';
import { attachVoiceDisplay, lookupVoiceMcpTool } from '../../mcp-tools/voiceToolDispatch.js';
import {
  filterOpenAiToolsForVoiceDisclosure,
  resolveVoiceTurnDisclosure,
  serializeVoiceRealtimeTools,
} from '../../mcp-tools/voiceToolResolver.js';
import { sanitizeLyknBots } from '../../mcp-tools/chatTools.js';
import { buildVoiceFamilyGuidance } from '../../mcp-tools/chatToolGuidance.js';
import { buildVoiceBotsSection } from '../ai/chatGuidance.js';
import { boundToolResult } from '../../mcp-tools/toolResultBounds.js';
import {
  createUserAuthorizedProject,
  resolveProjectByNameOrId,
} from '../../lib/projectWriteTarget.js';
import {
  getOrCreateSession,
  logAiUsage,
  estimateTokens,
  extractOpenAIUsage,
} from '../../usageTracking.js';
import {
  VOICE_SESSION_TTL_MS,
  resolveVoiceSessionSecret,
  signLyknVoiceToken as signVoiceToken,
  verifyLyknVoiceToken as verifyVoiceToken,
} from '../ai/voiceSessionToken.js';
import { resolveMcpToolsForTurn, executeMcpToolByBridgedName } from '../../lib/mcp/chatTurn.js';
import { getMcpManager } from './mcp.routes.js';

/**
 * @param {import('express').Express} app
 * @param {object} deps bootstrap-owned singletons from server.js: auth/access
 *   middleware, the ai/generation/elevenLlm rate limiters, checkAiUsageLimit,
 *   the supabaseAdmin client, server-local memCache/sha256/safeErr/
 *   timingSafeEqualStr helpers, the MCP tool context + project-section
 *   helpers shared with the chat path, and the synthesis-coupled voice
 *   grounding/briefing builders (left in server.js — LEGACY CANDIDATE,
 *   pending Memory Architecture Replacement).
 */
export function registerVoiceRoutes(app, {
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
}) {
  // ──────────────────────────────────────────────────
  // TTS — OpenAI Text-to-Speech
  // ──────────────────────────────────────────────────
  // MP3 buffers cached by sha256(text+voice+model+speed). 30-min TTL.
  // Bounded to 64 entries so worst-case memory is ~64 × ~80 KB = ~5 MB.
  // This catches the long tail of repeated phrases ("OK", "Sure!", canned
  // confirmations) — the 99th percentile speaker says the same thing dozens
  // of times an hour.
  const _ttsCache = memCache('tts-mp3', { maxSize: 64, ttlMs: 30 * 60 * 1000 });

  app.post('/api/ai/tts', requireAuth, requireAppAccess, aiLimiter, generationLimiter, checkAiUsageLimit, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OpenAI API key not configured.' });
      }

      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Missing text field.' });

      const voice = String(req.body?.voice || 'nova').trim();
      // Default to tts-1 (half the cost of tts-1-hd, audibly indistinguishable
      // for short responses). Clients that explicitly want HD can still ask.
      const model = String(req.body?.model || 'tts-1').trim();
      const speed = Math.max(0.25, Math.min(4, Number(req.body?.speed) || 1));

      const cacheKey = sha256(`${model}|${voice}|${speed}|${text}`);
      const cachedBuf = _ttsCache.get(cacheKey);
      if (cachedBuf) {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', String(cachedBuf.length));
        res.setHeader('X-LYKN-Cache', 'hit');
        return res.end(cachedBuf);
      }

      const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: 'mp3',
          speed,
        }),
      });

      if (!ttsRes.ok) {
        const errData = await ttsRes.json().catch(() => ({}));
        const msg = String(errData?.error?.message || ttsRes.statusText || 'TTS request failed');
        return res.status(500).json({ error: `TTS: ${msg}` });
      }

      const charCount = text.length;
      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'tts',
          model, provider: 'openai',
          inputTokens: Math.ceil(charCount / 4),
          metadata: { characters: charCount },
        });
      }).catch(() => {});

      // Buffer the response so we can both stream to the client AND cache
      // it. For TTS payloads (typically 20-300 KB) this is strictly better
      // than streaming + tee — mp3s play instantly once the client has the
      // whole buffer anyway.
      const arrayBuf = await ttsRes.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      // Don't cache abnormally large clips (>1 MB) — those are usually long
      // dictated content that won't repeat.
      if (buf.length > 0 && buf.length <= 1_000_000) {
        _ttsCache.set(cacheKey, buf);
      }
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('X-LYKN-Cache', 'miss');
      return res.end(buf);
    } catch (error) {
      if (!res.headersSent) {
        return res.status(500).json({ error: `TTS failed: ${error?.message || 'Unknown error'}` });
      }
      res.end();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Realtime voice (speech-to-speech) — mint a short-lived ephemeral client
  // secret the browser uses to open a WebRTC session directly with OpenAI.
  // The real API key never reaches the client. Grounding lives in the
  // `instructions` the client assembles from the user's LYKN context.
  // ──────────────────────────────────────────────────────────────────────────
  const REALTIME_VOICES = new Set(['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
  // Default LYKN voice. 'cedar' is the newest, most natural male voice for
  // gpt-realtime (other male options: ash, verse, echo).
  const LYKN_DEFAULT_REALTIME_VOICE = 'cedar';
  const LYKN_REALTIME_BASE_INSTRUCTIONS =
    "You are LYKN, the user's personal AI companion speaking out loud in a live voice conversation. " +
    "You have access to the user's Markdown Memory, active project state, and saved knowledge provided as context below. " +
    "Ground personal answers in that context. Be personally contextual, never a generic assistant. " +
    "Speak naturally and conversationally, in short spoken-friendly sentences. Avoid markdown, bullet lists, code blocks, " +
    "or reading URLs aloud. " +
    "IMPORTANT: the context below contains formatting tokens such as section headers in brackets (e.g. [WHO_I_AM], " +
    "[WHAT_IM_ON], [WHAT_IVE_SAVED]). These are silent guidance for you ONLY. " +
    "NEVER read bracketed section names aloud and never emit hidden tags. " +
    "SHARED IMAGES & FILES — you CAN work with them: when the user pastes, drops, uploads, or shares an image, screenshot, " +
    "photo, PDF, document, or link (or asks about one they just shared), it arrives in your context as a written description " +
    "plus any text extracted from it (look for 'The user just shared…', 'What the image shows:', or extracted/OCR text). " +
    "TREAT THAT AS HAVING SEEN OR READ IT. NEVER say you can't view images or files. If details have not arrived yet, " +
    "say you're still taking it in — never that you're unable to. " +
    "TOOLS: only the tools listed for this turn exist. Before you act, say ONE short natural sentence about what " +
    "you're doing ('Sure — pulling that up now', 'Running that now'), then call the tool in the SAME turn. " +
    "Never announce an action and then stop without calling the tool. " +
    "Things the user made with LYKN live in AI Drive — pull them up with open_app. Files and real apps on their " +
    "Mac use the local_ tools. Weather, news, prices, and current events use web_search. There is no vault search. " +
    "Suggest a new project in one line, then create_project only after a clear yes. " +
    "Never mention deleted memory stores (facts, beliefs, rules, synthesis, propose_fact, get_facts, get_beliefs). " +
    "VENDOR SILENCE (absolute): you are LYKN. NEVER name ElevenLabs, Whisper, Deepgram, Together AI, Render, Vercel, Supabase, or AWS. " +
    "If asked what powers you, the answer is LYKN. The only exception is the user's OWN connected apps (Gmail, Slack, etc.). " +
    "BRAND SPELLING: always say LYKN — all caps.";

  // Canonical Voice tool defs live in mcp-tools/voiceTools.js.
  // Per-turn disclosure uses FirstPartyCapabilityResolver via voiceToolResolver.js.

  // Current-time context for the voice models. The voice LLM has no inherent
  // clock, so it can't compute an absolute remind_at without this. We give it
  // "now" in UTC + guidance to prefer relative (in_minutes) phrasing, which is
  // timezone-independent and covers the common voice case ("remind me in an
  // hour"). Refreshed per session / per custom-LLM turn so it stays accurate.


  app.post('/api/ai/realtime/session', requireAuth, requireAppAccess, aiLimiter, generationLimiter, checkAiUsageLimit, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(500).json({ error: 'OpenAI API key not configured.' });
      }
      const model = String(req.body?.model || 'gpt-realtime').trim() || 'gpt-realtime';
      const requestedVoice = String(req.body?.voice || LYKN_DEFAULT_REALTIME_VOICE).trim().toLowerCase();
      const voice = REALTIME_VOICES.has(requestedVoice) ? requestedVoice : LYKN_DEFAULT_REALTIME_VOICE;
      // Markdown Memory is resolved server-side from the authenticated account.
      // Client workspace and recent-conversation grounding is layered on top.
      const memoryGrounding = await buildRealtimeMemoryGrounding(req.headers.authorization, req.user?.id);
      const clientGrounding = String(req.body?.instructions || '').slice(0, 8000).trim();
      const contextParts = [];
      contextParts.push(currentTimeContextLine());
      if (memoryGrounding) contextParts.push(memoryGrounding);
      if (clientGrounding) contextParts.push(`[WORKSPACE_AND_CONVERSATION]\n${clientGrounding}`);
      const instructions = (contextParts.length
        ? `${LYKN_REALTIME_BASE_INSTRUCTIONS}\n\n${contextParts.join('\n\n')}`
        : LYKN_REALTIME_BASE_INSTRUCTIONS
      ).slice(0, 14000);

      const sessionConfig = {
        session: {
          type: 'realtime',
          model,
          instructions,
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              turn_detection: { type: 'server_vad', create_response: false },
            },
            output: { voice },
          },
          tools: [],
          tool_choice: 'auto',
        },
      };

      const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sessionConfig),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = String(data?.error?.message || r.statusText || 'Failed to create realtime session');
        return res.status(r.status === 401 ? 500 : r.status || 500).json({ error: `Realtime: ${msg}` });
      }

      // Ephemeral secret can live at the top level (`value`) or nested under
      // `client_secret` depending on API revision — accept either.
      const clientSecret = data?.value || data?.client_secret?.value || data?.client_secret || null;
      if (!clientSecret) {
        return res.status(500).json({ error: 'Realtime: no client secret returned.' });
      }

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'realtime_voice',
          model, provider: 'openai',
          metadata: { voice },
        });
      }).catch(() => {});

      return res.json({
        value: clientSecret,
        expires_at: data?.expires_at || null,
        model,
        voice,
      });
    } catch (error) {
      return res.status(500).json({ error: `Realtime session failed: ${error?.message || 'Unknown error'}` });
    }
  });

  // Resolve the Voice tool subset for this utterance. The Realtime session
  // starts with zero tools (latency); the client session.updates before
  // creating a response. Deterministic — no extra LLM call.
  app.post('/api/ai/realtime/tools', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const message = String(req.body?.message || req.body?.transcript || '').trim();
      // Connected-app (MCP) tools for this utterance — same resolution the
      // text chat uses, so a connected Gmail behaves identically in voice.
      let mcpTurn = { tools: [] };
      if (message && req.user?.id) {
        try {
          mcpTurn = await resolveMcpToolsForTurn({
            manager: getMcpManager(supabaseAdmin),
            userId: req.user.id,
            text: message,
          });
        } catch {
          mcpTurn = { tools: [] };
        }
      }
      const disclosure = resolveVoiceTurnDisclosure({
        message,
        localMode: Boolean(req.body?.localMode ?? req.body?.desktop),
        lyknBots: sanitizeLyknBots(req.body?.lyknBots),
        resolveExternal: () => mcpTurn.tools,
      });
      const tools = [
        ...serializeVoiceRealtimeTools(disclosure.firstPartyToolNames),
        ...(disclosure.externalTools || []).map((t) => ({
          type: 'function',
          name: t.name,
          description: t.description || '',
          parameters:
            t.inputSchema && typeof t.inputSchema === 'object'
              ? t.inputSchema
              : { type: 'object', properties: {} },
        })),
      ];
      const guidance = buildVoiceFamilyGuidance(disclosure.capabilities);
      return res.json({
        tools,
        capabilities: disclosure.capabilities,
        firstPartyToolNames: disclosure.firstPartyToolNames,
        externalToolNames: (disclosure.externalTools || []).map((t) => t.name),
        guidance,
        inspect: disclosure.inspect,
      });
    } catch (error) {
      return res.status(500).json({ error: `Realtime tools failed: ${error?.message || 'Unknown error'}` });
    }
  });

  // Execute a tool call requested by the realtime voice model. The browser
  // relays the model's function_call here (authed with the user's JWT), we run
  // it against the SAME synthesis-layer capabilities the text chat / MCP use,
  // and return JSON the client feeds back as the tool output. Secrets + DB
  // access stay server-side; the realtime model never sees them.
  app.post('/api/ai/realtime/tool', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ ok: false, error: 'Unauthorized' });

      const name = String(req.body?.name || '').trim();
      let args = req.body?.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args || '{}'); } catch { args = {}; }
      }
      if (!args || typeof args !== 'object') args = {};
      const authHeader = req.headers.authorization;

      // Connected-app (MCP) tools disclosed by /realtime/tools carry bridged
      // mcp_* names. Execute through the shared MCP gate stack (connection
      // status, capability check, consequence approval, untrusted wrapping).
      if (/^mcp_/.test(name)) {
        const executed = await executeMcpToolByBridgedName({
          manager: getMcpManager(supabaseAdmin),
          userId,
          name,
          args,
          taskId: `voice_${userId}`,
        });
        return res.json(
          boundToolResult(name, executed.observation || { ok: executed.ok !== false, ...executed }),
        );
      }

      // Run one of the existing MCP tool handlers with a JWT ctx (in-LYKN
      // privileges — no read-only token gate), unwrapping its content block
      // into plain JSON.
      const runMcp = async (mcpName, mcpArgs) => {
        // LYKN tools live in LYKN_TOOLS_BY_NAME; on-demand
        // exterior capabilities (web search/fetch, etc.) live in
        // EXTERIOR_TOOLS_BY_NAME. Voice tool defs can map to either, so fall
        // through to exterior.
        const tool = lookupVoiceMcpTool(mcpName);
        if (!tool) return { ok: false, error: 'tool_unavailable' };
        const ctx = buildToolCtx(req);
        const result = await tool.handler(mcpArgs, ctx);
        if (!result?.isError && PROJECT_WRITE_TOOLS.has(mcpName)) invalidateProjectSectionCache(ctx.userId);
        const block = Array.isArray(result?.content) ? result.content[0] : null;
        if (block?.type === 'text') {
          try { return boundToolResult(mcpName, JSON.parse(block.text)); } catch { return { ok: !result?.isError, text: String(block.text) }; }
        }
        return boundToolResult(mcpName, { ok: !result?.isError });
      };

      // The legacy vault trio (search_vault / read_document / display_document)
      // is retired — Chat parity: AI Drive items open with open_app, Mac files
      // use local_*. Retired names fall through to the unknown_tool response.

      if (name === 'get_project_state') {
        const projectSection = await fetchProjectSection(authHeader, userId);
        const text = projectSection?.text || '';
        return res.json({
          ok: true,
          project_state: text && text.trim() ? text.slice(0, 6000) : 'No active project is set, or it has no recorded state yet.',
        });
      }

      // Create a project the user just agreed to start (confirm-first lives in the
      // tool description + voice instructions). Writes a user-authorized row that
      // shows up under Projects and becomes the active focus.
      if (name === 'create_project') {
        const projectName = String(args.name || '').trim();
        if (!projectName) return res.json({ ok: false, error: 'A project name is required.' });
        const created = await createUserAuthorizedProject(supabaseAdmin, userId, {
          name: projectName,
          description: args.description,
          client: 'lykn-synthesis',
        });
        if (!created.ok) {
          return res.json({ ok: false, error: 'could_not_create', message: 'I could not start that project just now.' });
        }
        invalidateProjectSectionCache(userId);
        return res.json({
          ok: true,
          was_created: created.was_created,
          project: { id: created.project.id, name: created.project.name },
          message: created.was_created
            ? `Started "${created.project.name}" — it's now in the user's projects and set as the active focus.`
            : `"${created.project.name}" already existed — reactivated it and set it as the active focus.`,
        });
      }

      // Communicate with one of the user's OTHER models (a sub-agent) and read
      // back its report. Not a plain MCP passthrough (the tool runs the sub-model
      // delegate), so run its self-contained handler with the JWT ctx directly.
      if (name === 'communicate_with_model') {
        const ctx = buildToolCtx(req);
        const result = await communicateWithModelTool.handler(args, ctx);
        const block = Array.isArray(result?.content) ? result.content[0] : null;
        if (block?.type === 'text') {
          try { return res.json(JSON.parse(block.text)); }
          catch { return res.json({ ok: !result?.isError, text: String(block.text) }); }
        }
        return res.json({ ok: !result?.isError });
      }

      // Web search for VOICE is snippets-only: the default lykn_web_search
      // handler deep-browses the top 3 result pages, which routinely blows past
      // the voice client's tool timeout (the user just hears "I'm having trouble
      // getting the latest news"). The spoken answer only needs titles +
      // snippets, so skip deepBrowse and cap results for a ~1-2s response.
      if (name === 'web_search') {
        const query = String(args.query || '').trim();
        if (!query) return res.json({ ok: false, error: 'query is required.' });
        const num = Math.max(1, Math.min(6, Number(args.num_results) || 5));
        const out = await searchWeb(query, { num, deepBrowse: false });
        if (!out?.ok) {
          return res.json({
            ok: false,
            error: out?.error || 'search_failed',
            message:
              out?.error === 'web_search_not_configured'
                ? 'Web search is not configured on the server (missing SERPER_API_KEY).'
                : 'Could not complete the web search.',
          });
        }
        const results = (out.results || []).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet,
        }));
        return res.json({
          ok: true,
          query: out.query,
          result_count: results.length,
          results,
        });
      }

      // Add the file the user just shared into this voice session to a project.
      // Files dragged/pasted during voice are auto-saved to the vault (tagged
      // source='lykn-voice-attachment'); this resolves the project by name and,
      // when the model doesn't pass a node, the most-recently shared file, then
      // clusters it into the project. Mirrors lykn_uploadToProject for chat.
      if (name === 'add_to_project') {
        const ctx = buildToolCtx(req);
        const projectName = String(args.project_name || '').trim();
        const projectId = String(args.project_id || '').trim();
        const { project, reason } = await resolveProjectByNameOrId(ctx, { projectId, projectName });
        if (!project) {
          if (reason === 'project_name_not_found') {
            return res.json({ ok: false, reason: 'project_not_found', message: `I couldn't find a project called "${projectName}". Which project should it go in?` });
          }
          return res.json({ ok: false, reason: 'no_active_project', message: 'No target project is set. Tell me which project to add it to.' });
        }

        // Resolve the vault item: an explicit node_id wins; otherwise the most
        // recently shared file (the "this" the user is referring to).
        let nodeId = String(args.node_id || '').trim();
        let nodeLabel = '';
        if (nodeId) {
          if (!nodeId.startsWith('vault_')) nodeId = `vault_${nodeId}`;
        } else {
          const { data: recent } = await supabaseAdmin
            .from('vault_items')
            .select('id, title')
            .eq('user_id', userId)
            .eq('source', 'lykn-voice-attachment')
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!recent?.id) {
            return res.json({ ok: false, reason: 'no_recent_attachment', message: "I don't see a file you've shared in this session yet. Drag or paste it in first, then I can add it." });
          }
          nodeId = `vault_${recent.id}`;
          nodeLabel = recent.title || '';
        }

        const { error: clusterErr } = await supabaseAdmin
          .from('lykn_project_neurons')
          .upsert(
            {
              user_id: userId,
              project_id: project.id,
              node_id: nodeId,
              node_label: (nodeLabel || 'Shared file').slice(0, 240),
              node_kind: 'vault',
            },
            { onConflict: 'user_id,project_id,node_id' },
          );
        if (clusterErr) {
          return res.json({ ok: false, reason: 'clustering_failed', message: `I couldn't add it to "${project.name}" just now.` });
        }
        await supabaseAdmin
          .from('lykn_projects')
          .update({ last_active_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', project.id)
          .eq('user_id', userId)
          .then(() => {}, () => {});
        invalidateProjectSectionCache(userId);
        return res.json({
          ok: true,
          project: { id: project.id, name: project.name },
          node_id: nodeId,
          message: `Added it to "${project.name}".`,
        });
      }

      // save_to_vault safety net: voice models sometimes save a link as a plain
      // note ("Article: https://…"), which the vault renders as raw text (URLs
      // are even stripped from quick-note excerpts) instead of an embedded card.
      // When the note is fundamentally a URL — a link plus at most a short
      // title/summary — reroute it to lykn_saveLinkToVault so it lands as the
      // same rich card a manual drop produces. Longer bodies that merely
      // mention a URL stay plain notes (fall through to the generic dispatch).
      if (name === 'save_to_vault') {
        const content = String(args.content || '');
        const urlMatch = content.match(/https?:\/\/[^\s)\]>"']+/i);
        if (urlMatch) {
          const url = urlMatch[0].replace(/[.,;:!?]+$/, '');
          const leftover = content
            .replace(/https?:\/\/[^\s)\]>"']+/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (leftover.length <= 280) {
            const out = await runMcp('lykn_saveLinkToVault', {
              url,
              ...(args.title ? { title: String(args.title).slice(0, 200) } : {}),
              ...(leftover ? { summary: leftover.slice(0, 4000) } : {}),
            });
            // saveLinkToVault rejects some URLs (e.g. generated artifacts);
            // fall back to the plain note rather than losing the save.
            if (out?.ok !== false) return res.json(out);
          }
        }
      }

      // Generic synthesis-layer tools → run the mapped MCP handler with the
      // model-provided args passed straight through (each handler validates +
      // applies its own defaults / write-scope).
      const mcpName = LYKN_VOICE_TOOL_MCP[name];
      if (mcpName) {
        const out = await runMcp(mcpName, args);
        return res.json(boundToolResult(name, attachVoiceDisplay(name, out)));
      }

      return res.status(404).json({ ok: false, error: 'unknown_tool' });
    } catch (e) {
      console.error('❌ /api/ai/realtime/tool:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'tool_failed' });
    }
  });

  // ── Self-tuning instructions ───────────────────────────────────────────────
  // The user can tell the assistant — in voice or chat — to adjust how it
  // behaves ("turn up the sarcasm by 15%", "be more concise", "act more like a
  // coach"). This rewrites the user's OWN saved instruction prompt (their
  // personal voice- or chat-instructions text) by surgically applying that
  // suggestion to the current text while preserving everything else. The CLIENT
  // owns persistence (the prompt lives in the user's local settings); this
  // endpoint only performs the language rewrite and returns the new text plus a
  // short summary of what changed.
  const TUNE_INSTRUCTIONS_MAX_LEN = 1500;
  app.post('/api/ai/tune-instructions', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      if (!process.env.OPENAI_API_KEY) {
        return res.status(503).json({ ok: false, error: 'tuning_unavailable' });
      }
      const suggestion = String(req.body?.suggestion || '').trim().slice(0, 600);
      if (!suggestion) {
        return res.json({ ok: false, error: 'missing_suggestion', message: 'A suggestion is required.' });
      }
      const current = String(req.body?.current || '').trim().slice(0, TUNE_INSTRUCTIONS_MAX_LEN);
      const scope = String(req.body?.scope || 'voice').trim().toLowerCase() === 'chat' ? 'chat' : 'voice';

      const channel = scope === 'chat'
        ? 'how the assistant should respond in TEXT chat (tone, format, what to always or never do)'
        : 'how the assistant should sound and behave in live VOICE conversations (pace, warmth, formality, personality, the overall feel)';

      const sys =
        "You maintain a user's personal instruction prompt for their AI assistant. " +
        `The instruction prompt describes ${channel}. ` +
        'You are given the CURRENT instruction text and a SUGGESTION the user just gave for how to change the assistant\'s behavior. ' +
        'Apply the suggestion to the current text and return the FULL updated instruction prompt. ' +
        'Rules: keep everything in the current text that the suggestion does not touch — only adjust what the suggestion targets. ' +
        "Write plain second-person directives addressed to the assistant ('Speak…', 'Be…', 'Use…'). " +
        "Interpret relative tweaks ('turn up the sarcasm by 15%', 'a bit warmer', 'talk less') as a modest, sensible shift — never extreme, and fold them into prose rather than emitting literal percentages. " +
        'If the current text is empty, write a concise new instruction that captures the suggestion. ' +
        `Keep it tight and natural, well under ${TUNE_INSTRUCTIONS_MAX_LEN} characters. ` +
        'Output ONLY valid JSON: {"instructions":"the full updated instruction text","summary":"one short present-tense phrase describing what changed, e.g. turned up the sarcasm"}';

      const userMsg =
        `CURRENT INSTRUCTION TEXT:\n${current || '(empty — none set yet)'}\n\nUSER SUGGESTION:\n${suggestion}`;

      const ores = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4.1-mini',
          temperature: 0.4,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg },
          ],
        }),
      });
      if (!ores.ok) {
        const t = await ores.text().catch(() => '');
        console.warn('⚠️ tune-instructions LLM HTTP', ores.status, t.slice(0, 300));
        return res.json({ ok: false, error: 'rewrite_failed', message: "I couldn't update the instructions just now." });
      }
      const odata = await ores.json().catch(() => ({}));
      let parsed = {};
      try { parsed = JSON.parse(odata?.choices?.[0]?.message?.content || '{}'); } catch { parsed = {}; }
      const instructions = String(parsed?.instructions || '').trim().slice(0, TUNE_INSTRUCTIONS_MAX_LEN);
      if (!instructions) {
        return res.json({ ok: false, error: 'rewrite_failed', message: "I couldn't update the instructions just now." });
      }
      const summary = String(parsed?.summary || '').trim().slice(0, 120);

      try {
        logAiUsage({
          userId: req.user?.id, actionType: 'tune_instructions',
          model: 'gpt-4.1-mini', provider: 'openai',
          inputTokens: extractOpenAIUsage(odata)?.input_tokens || estimateTokens(userMsg),
          outputTokens: extractOpenAIUsage(odata)?.output_tokens || estimateTokens(instructions),
          metadata: { scope },
        });
      } catch { /* telemetry never blocks the rewrite */ }

      return res.json({ ok: true, scope, instructions, summary });
    } catch (e) {
      console.error('❌ /api/ai/tune-instructions:', e?.message || e);
      return res.status(500).json({ ok: false, error: 'tune_failed' });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // ELEVENLABS CONVERSATIONAL AI — alternative voice provider (behind a flag)
  // ══════════════════════════════════════════════════════════════════════════
  // Architecture: the browser connects to an ElevenLabs Agent (signed URL minted
  // below). The agent uses a CUSTOM LLM that points back at THIS server
  // (/api/ai/elevenlabs/llm/chat/completions), so the voice brain reuses LYKN
  // grounding + the same client tools the OpenAI Realtime path uses. Per-user
  // identity flows through a short-lived signed session token embedded as a
  // dynamic variable in the agent prompt; the custom-LLM endpoint reads it back.
  //
  // NOTE: ElevenLabs calls the custom-LLM endpoint server-to-server, so this
  // server must be publicly reachable for the full loop (won't work on
  // localhost). The OpenAI Realtime path remains the default.

  // Dedicated HMAC key for voice/file-proxy session tokens. Must NOT fall back to
  // the service-role key (that would couple token-forgery blast radius to the DB
  // master key) or to a hard-coded dev string (forgeable). validateSecrets()
  // makes VOICE_SESSION_SECRET mandatory in production; resolveVoiceSessionSecret
  // mints a random per-process fallback in development so local runs still work
  // without ever shipping a predictable secret.
  const VOICE_SESSION_SECRET = resolveVoiceSessionSecret();

  // Per-conversation grounding, keyed by the signed session token. Lets the
  // custom-LLM endpoint recover the client-built context (workspace summary +
  // recent conversation) that only the browser had at session start. Best-effort
  // (in-memory): on a miss we fall back to userId-only synthesis grounding.
  const voiceSessionGrounding = new Map(); // token -> { instructions, at }
  // Latest screen description the desktop overlay pushed, keyed by user id. Kept
  // separate from (and in addition to) the token-keyed entry so the custom-LLM
  // can find it even when grounding falls back to the userId-only path.
  const voiceScreenByUser = new Map(); // userId -> { text, at }
  function pruneVoiceSessions() {
    const now = Date.now();
    for (const [k, v] of voiceSessionGrounding) {
      if (!v || now - v.at > VOICE_SESSION_TTL_MS) voiceSessionGrounding.delete(k);
    }
    for (const [k, v] of voiceScreenByUser) {
      if (!v || now - v.at > VOICE_SESSION_TTL_MS) voiceScreenByUser.delete(k);
    }
  }

  function signLyknVoiceToken(payload) {
    return signVoiceToken(payload, VOICE_SESSION_SECRET, VOICE_SESSION_TTL_MS);
  }
  function verifyLyknVoiceToken(token) {
    return verifyVoiceToken(token, VOICE_SESSION_SECRET);
  }

  // Mint an ElevenLabs signed URL for the configured agent + a signed session
  // token that binds the conversation to this LYKN user. The client passes the
  // token to startSession as the `lykn_session_token` dynamic variable.
  app.post('/api/ai/elevenlabs/signed-url', requireAuth, requireAppAccess, aiLimiter, generationLimiter, checkAiUsageLimit, async (req, res) => {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      const agentId = process.env.ELEVENLABS_AGENT_ID;
      if (!apiKey || !agentId) {
        return res.status(503).json({ error: 'ElevenLabs voice is not configured yet.' });
      }

      // Prefer a WebRTC conversation token (LiveKit transport) — it carries a
      // jitter buffer + packet-loss concealment, which fixes the intermittent
      // pitch/speed wobble heard on the raw-PCM WebSocket transport. We still
      // mint a signed URL in parallel as a WebSocket fallback so a WebRTC hiccup
      // can degrade gracefully on the client.
      const [tokenRes, signedRes] = await Promise.allSettled([
        fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
          { headers: { 'xi-api-key': apiKey } },
        ),
        fetch(
          `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`,
          { headers: { 'xi-api-key': apiKey } },
        ),
      ]);

      let conversationToken = '';
      if (tokenRes.status === 'fulfilled' && tokenRes.value.ok) {
        const td = await tokenRes.value.json().catch(() => ({}));
        conversationToken = td?.token || td?.conversation_token || '';
      }

      let signedUrl = '';
      let signedErr = '';
      if (signedRes.status === 'fulfilled') {
        const sd = await signedRes.value.json().catch(() => ({}));
        signedUrl = sd?.signed_url || sd?.signedUrl || '';
        if (!signedRes.value.ok) {
          signedErr = String(sd?.detail?.message || sd?.detail || signedRes.value.statusText || 'Failed to get signed URL');
        }
      }

      // Need at least one usable transport credential.
      if (!conversationToken && !signedUrl) {
        return res.status(502).json({ error: `ElevenLabs: ${signedErr || 'Failed to start voice session'}` });
      }

      // Gather the opening-briefing facts once: used both to phrase the spoken
      // offer line and to inject the briefing into the session grounding so the
      // model can deliver it when the user accepts the offer.
      const briefingData = await gatherVoiceBriefingData(req.headers.authorization, req.user?.id).catch((e) => {
        console.warn('⚠️ voice briefing gather:', e?.message || e);
        return null;
      });

      // Build the same grounded instructions the OpenAI path uses, stash them so
      // the custom-LLM endpoint can recover the client context for this call.
      const memoryGrounding = await buildRealtimeMemoryGrounding(req.headers.authorization, req.user?.id);
      const clientGrounding = String(req.body?.instructions || '').slice(0, 8000).trim();
      const parts = [];
      // Briefing block goes first so it survives the 14k truncation below.
      const briefingBlock = formatVoiceBriefingInstructionBlock(req.user, briefingData);
      const sessionBots = sanitizeLyknBots(req.body?.lyknBots);
      const sessionLocalMode = Boolean(req.body?.localMode ?? req.body?.desktop);
      const botsBlock = buildVoiceBotsSection(sessionBots);
      if (briefingBlock) parts.push(briefingBlock);
      if (botsBlock) parts.push(botsBlock);
      if (memoryGrounding) parts.push(memoryGrounding);
      if (clientGrounding) parts.push(`[WORKSPACE_AND_CONVERSATION]\n${clientGrounding}`);
      const instructions = (parts.length
        ? `${LYKN_REALTIME_BASE_INSTRUCTIONS}\n\n${parts.join('\n\n')}`
        : LYKN_REALTIME_BASE_INSTRUCTIONS
      ).slice(0, 14000);

      const sessionToken = signLyknVoiceToken({ uid: req.user?.id, board: req.body?.chatId || null });
      pruneVoiceSessions();
      // Capture the browser's IANA timezone so the custom-LLM endpoint can give
      // the voice model the user's LOCAL "now" (the custom-LLM calls come from
      // ElevenLabs, which has no idea what timezone the user is in).
      const sessionTz = typeof req.body?.timezone === 'string' ? req.body.timezone.trim().slice(0, 64) : '';
      voiceSessionGrounding.set(sessionToken, {
        instructions,
        tz: sessionTz,
        lyknBots: sessionBots,
        desktop: sessionLocalMode,
        localMode: sessionLocalMode,
        at: Date.now(),
      });

      getOrCreateSession(req.user?.id, req.body?.chatId).then((session) => {
        logAiUsage({
          sessionId: session?.id, userId: req.user?.id, actionType: 'elevenlabs_voice',
          model: 'elevenlabs-convai', provider: 'elevenlabs', metadata: { agent_id: agentId },
        });
      }).catch(() => {});

      // Opening line: a Jarvis-style greeting that offers the briefing (the
      // briefing itself is in the grounding above, delivered on acceptance).
      const firstMessage = buildVoiceBriefingOffer(req.user, briefingData);

      return res.json({ conversationToken, signedUrl, sessionToken, firstMessage });
    } catch (error) {
      return res.status(500).json({ error: `ElevenLabs signed URL failed: ${error?.message || 'Unknown error'}` });
    }
  });

  // Voice Mode (desktop overlay): push a fresh text description of the user's
  // current screen. We stash it against the live session token so the custom-LLM
  // endpoint injects it into every turn's grounding — giving voice the same
  // "sees your screen" ability the typed overlay chat has. Best-effort and
  // non-blocking; the screen is captured + described in the Electron app.
  app.post('/api/ai/realtime/screen', requireAuth, requireAppAccess, aiLimiter, async (req, res) => {
    try {
      const sessionToken = String(req.body?.sessionToken || '').trim();
      const text = String(req.body?.text || '').slice(0, 4000).trim();
      if (!sessionToken) return res.status(400).json({ ok: false, error: 'missing_token' });
      const session = verifyLyknVoiceToken(sessionToken);
      if (!session || (session.uid && req.user?.id && session.uid !== req.user.id)) {
        return res.status(401).json({ ok: false, error: 'bad_token' });
      }
      pruneVoiceSessions();
      const cur = voiceSessionGrounding.get(sessionToken)
        || { instructions: LYKN_REALTIME_BASE_INSTRUCTIONS, tz: '', at: Date.now() };
      cur.screen = text ? { text, at: Date.now() } : null;
      voiceSessionGrounding.set(sessionToken, cur);
      // Also key by user id so the custom-LLM can find it on the userId path.
      const uid = session.uid || req.user?.id || null;
      if (uid) {
        if (text) voiceScreenByUser.set(uid, { text, at: Date.now() });
        else voiceScreenByUser.delete(uid);
      }
      // Persist to the DB so OTHER server instances (Render scales horizontally)
      // can read it — the custom-LLM call from ElevenLabs usually lands on a
      // different instance than this push. Fire-and-forget to keep this fast.
      if (uid && supabaseAdmin) {
        supabaseAdmin
          .from('voice_screen_context')
          .upsert(
            { user_id: uid, description: text || '', updated_at: new Date().toISOString() },
            { onConflict: 'user_id' },
          )
          .then(({ error }) => {
            if (error) console.warn('⚠️ voice_screen_context upsert:', error.message);
          });
      }
      console.log(`[screen-store] token=${sessionToken.slice(0, 8)}… user=${uid || 'none'} chars=${text.length}`);
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ ok: false, error: safeErr(error, 'screen_update_failed') });
    }
  });

  // List the workspace's available ElevenLabs voices for the in-app voice picker.
  // Proxied so the API key never reaches the browser. Returns a slim, UI-ready
  // shape (id, name, preview clip, a one-line descriptor) and is cached for an
  // hour since the voice roster changes rarely.
  const _elevenVoicesCache = memCache('elevenlabs-voices', { maxSize: 1, ttlMs: 60 * 60 * 1000 });
  app.get('/api/ai/elevenlabs/voices', requireAuth, requireAppAccess, async (req, res) => {
    try {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        return res.status(503).json({ error: 'ElevenLabs voice is not configured yet.' });
      }

      const cached = _elevenVoicesCache.get('voices');
      if (cached) return res.json({ voices: cached, defaultVoiceId: process.env.ELEVENLABS_VOICE_ID || null });

      const elRes = await fetch('https://api.elevenlabs.io/v1/voices', {
        headers: { 'xi-api-key': apiKey },
      });
      const data = await elRes.json().catch(() => ({}));
      if (!elRes.ok) {
        const msg = String(data?.detail?.message || data?.detail || elRes.statusText || 'Failed to load voices');
        return res.status(502).json({ error: `ElevenLabs: ${msg}` });
      }

      const raw = Array.isArray(data?.voices) ? data.voices : [];
      const voices = raw.map((v) => {
        const labels = v?.labels && typeof v.labels === 'object' ? v.labels : {};
        // Build a short, human descriptor from the voice's labels
        // (e.g. "American · warm · narration") with no provider branding.
        const descriptor = [labels.accent, labels.gender, labels.age, labels.use_case, labels.description]
          .map((s) => (typeof s === 'string' ? s.trim() : ''))
          .filter(Boolean)
          .slice(0, 3)
          .join(' · ');
        return {
          id: v?.voice_id || '',
          name: v?.name || 'Voice',
          previewUrl: v?.preview_url || '',
          descriptor,
          category: v?.category || '',
        };
      }).filter((v) => v.id);

      _elevenVoicesCache.set('voices', voices);
      return res.json({ voices, defaultVoiceId: process.env.ELEVENLABS_VOICE_ID || null });
    } catch (error) {
      return res.status(500).json({ error: `ElevenLabs voices failed: ${error?.message || 'Unknown error'}` });
    }
  });

  // Custom-LLM endpoint for the ElevenLabs agent. OpenAI Chat Completions
  // compatible: ElevenLabs POSTs the conversation here, we inject LYKN grounding
  // into the system message, then stream OpenAI's response straight back. Tools
  // the agent declares are passed through untouched (ElevenLabs executes the
  // resulting tool_calls as client tools in the browser).
  const LYKN_SESSION_TOKEN_RE = /LYKN_SESSION_TOKEN=(\S+)/;
  const elevenCustomLlmHandler = async (req, res) => {
    customLlmStats.hits += 1;
    customLlmStats.lastHitAt = new Date().toISOString();
    customLlmStats.lastPath = req.originalUrl;
    try {
      // Auth: ElevenLabs sends the configured custom-LLM API key as a bearer.
      const expected = process.env.ELEVENLABS_LLM_SECRET;
      if (!expected || String(expected).length < 32) {
        customLlmStats.lastResult = 'no_secret_configured';
        return res.status(503).json({ error: 'Custom LLM not configured.' });
      }
      const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      if (!timingSafeEqualStr(presented, expected)) {
        customLlmStats.authFails += 1;
        customLlmStats.lastResult = 'auth_fail';
        // Don't record any prefix of the presented secret — a leaked prefix
        // narrows a brute-force. Length alone is enough to debug misconfig.
        customLlmStats.lastAuthFail = { at: new Date().toISOString(), presentedLen: presented.length };
        return res.status(401).json({ error: 'Unauthorized' });
      }

      if (!process.env.OPENAI_API_KEY) { customLlmStats.lastResult = 'no_openai'; return res.status(503).json({ error: 'OpenAI not configured.' }); }

      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const messages = Array.isArray(body.messages) ? [...body.messages] : [];

      // Recover the session token from the agent's system prompt, resolve the
      // LYKN user, and build grounding. Falls back gracefully if absent.
      let sessionToken = '';
      for (const m of messages) {
        const content = typeof m?.content === 'string' ? m.content : '';
        const match = content.match(LYKN_SESSION_TOKEN_RE);
        if (match) { sessionToken = match[1]; break; }
      }
      const session = sessionToken ? verifyLyknVoiceToken(sessionToken) : null;
      const userId = session?.uid || null;

      let grounding = '';
      let sessionTz = '';
      let screenText = '';
      let sessionBots = [];
      let sessionDesktop = false;
      if (sessionToken && voiceSessionGrounding.has(sessionToken)) {
        const stored = voiceSessionGrounding.get(sessionToken);
        grounding = stored?.instructions || '';
        sessionTz = stored?.tz || '';
        sessionBots = Array.isArray(stored?.lyknBots) ? stored.lyknBots : [];
        sessionDesktop = Boolean(stored?.localMode ?? stored?.desktop);
      } else if (userId) {
        const synth = await buildRealtimeMemoryGrounding(null, userId);
        grounding = (synth
          ? `${LYKN_REALTIME_BASE_INSTRUCTIONS}\n\n${synth}`
          : LYKN_REALTIME_BASE_INSTRUCTIONS
        ).slice(0, 14000);
      } else {
        grounding = LYKN_REALTIME_BASE_INSTRUCTIONS;
      }

      // Live screen the desktop overlay pushed — look up by session token first,
      // then by user id (so it's found regardless of which grounding path ran).
      // Best-effort with a ~60s freshness window.
      let screenEntry = null;
      if (sessionToken) {
        const st = voiceSessionGrounding.get(sessionToken);
        if (st?.screen?.text) screenEntry = st.screen;
      }
      if (!screenEntry && userId && voiceScreenByUser.has(userId)) {
        screenEntry = voiceScreenByUser.get(userId);
      }
      if (screenEntry?.text && Date.now() - (screenEntry.at || 0) < 60000) {
        screenText = screenEntry.text;
      }
      // Cross-instance fallback: the screen was likely pushed to a different
      // Render instance, so read the shared DB row when the in-memory miss occurs.
      if (!screenText && userId && supabaseAdmin) {
        try {
          const { data: scr } = await supabaseAdmin
            .from('voice_screen_context')
            .select('description, updated_at')
            .eq('user_id', userId)
            .maybeSingle();
          if (scr?.description && Date.now() - new Date(scr.updated_at).getTime() < 60000) {
            screenText = scr.description;
          }
        } catch (e) {
          console.warn('⚠️ voice_screen_context read:', e?.message || e);
        }
      }
      customLlmStats.lastTokenFound = !!sessionToken;
      customLlmStats.lastUserIdFound = !!userId;
      customLlmStats.lastScreenChars = screenText.length;
      customLlmStats.lastGroundingChars = grounding.length;
      console.log(`[custom-llm] token=${!!sessionToken} entry=${sessionToken ? voiceSessionGrounding.has(sessionToken) : false} userId=${!!userId} screenChars=${screenText.length}`);

      customLlmStats.lastRetrievalChars = 0;

      // Rebuild the message list: our grounded system message first, the fresh
      // per-turn retrieval next, then the original turns with the token line
      // scrubbed out of any system message.
      const rebuilt = [{ role: 'system', content: grounding }];
      // Live screen from the desktop overlay: phrased with the persona's
      // recognized "shared image" triggers so the model treats it as seen.
      if (screenText) {
        rebuilt.push({
          role: 'system',
          content:
            `[CURRENT_SCREEN] The user just shared a live screenshot of their current screen. ` +
            `What the image shows: ${screenText}\n` +
            `This is your live view of what is on the user's screen RIGHT NOW — answer questions ` +
            `about what they're looking at directly from this, and never say you can't see their screen.`,
        });
      }
      rebuilt.push({ role: 'system', content: localTimeContextLine(sessionTz) });
      const userText = lastUserTextFromMessages(messages);
      // Connected-app (MCP) tools for this utterance. The browser executes
      // the resulting tool_calls through /api/ai/realtime/tool, which
      // handles bridged mcp_* names with the full MCP gate stack.
      let elevenMcpTurn = { tools: [] };
      if (userText && userId) {
        try {
          elevenMcpTurn = await resolveMcpToolsForTurn({
            manager: getMcpManager(supabaseAdmin),
            userId,
            text: userText,
          });
        } catch {
          elevenMcpTurn = { tools: [] };
        }
      }
      const voiceDisclosure = resolveVoiceTurnDisclosure({
        message: userText,
        conversation: messages,
        localMode: sessionDesktop,
        lyknBots: sessionBots,
        resolveExternal: () => elevenMcpTurn.tools,
      });
      const voiceGuidance = buildVoiceFamilyGuidance(voiceDisclosure.capabilities);
      if (voiceGuidance) {
        rebuilt.push({ role: 'system', content: voiceGuidance });
      }
      for (const m of messages) {
        if (m?.role === 'system' && typeof m.content === 'string') {
          const scrubbed = m.content.replace(LYKN_SESSION_TOKEN_RE, '').trim();
          if (scrubbed) rebuilt.push({ ...m, content: scrubbed });
        } else {
          rebuilt.push(m);
        }
      }

      const filteredTools = filterOpenAiToolsForVoiceDisclosure(body.tools, voiceDisclosure);
      // Connected-app tools are per-user, so they are never in the agent's
      // static tool config — append them here.
      const haveToolNames = new Set(filteredTools.map((t) => t?.function?.name || t?.name));
      for (const t of voiceDisclosure.externalTools || []) {
        if (!t?.name || haveToolNames.has(t.name)) continue;
        filteredTools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || '',
            parameters:
              t.inputSchema && typeof t.inputSchema === 'object'
                ? t.inputSchema
                : { type: 'object', properties: {} },
          },
        });
      }
      const upstreamBody = {
        ...body,
        model: process.env.ELEVENLABS_LLM_MODEL || body.model || 'gpt-4o',
        messages: rebuilt,
        tools: filteredTools,
      };
      if (!filteredTools.length) {
        delete upstreamBody.tools;
        delete upstreamBody.tool_choice;
      }

      const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upstreamBody),
      });

      if (userId) {
        logAiUsage({
          userId, actionType: 'elevenlabs_voice_llm',
          model: upstreamBody.model, provider: 'openai', metadata: { via: 'elevenlabs_custom_llm' },
        }).catch(() => {});
      }

      // On upstream failure, capture the error body so we can see exactly what
      // OpenAI rejected (ElevenLabs only reports "custom_llm generation failed").
      if (!upstream.ok) {
        const errText = await upstream.text().catch(() => '');
        console.error(`❌ custom-LLM upstream ${upstream.status}:`, errText.slice(0, 1000));
        lastCustomLlmError = {
          at: new Date().toISOString(),
          status: upstream.status,
          upstreamBodyError: errText.slice(0, 2000),
          sentKeys: Object.keys(body),
          model: upstreamBody.model,
          messageRoles: rebuilt.map((m) => m.role),
          toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        };
        // The raw OpenAI error body is captured above (console.error +
        // lastCustomLlmError, visible on the authed _debug endpoint). Don't
        // forward it to the ElevenLabs-facing client — it can carry upstream
        // internals and the exact request shape. A generic message on the
        // upstream status is all the caller needs.
        res.status(upstream.status);
        return res.json({ error: 'Upstream model request failed.' });
      }

      customLlmStats.lastResult = `ok_${upstream.status}_${body.stream ? 'stream' : 'json'}`;
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
      if (upstream.body && typeof upstream.body.pipe === 'function') {
        upstream.body.pipe(res);
        upstream.body.on('error', () => { try { res.end(); } catch { /* ignore */ } });
      } else {
        const text = await upstream.text();
        res.send(text);
      }
    } catch (error) {
      console.error('❌ /api/ai/elevenlabs/llm/chat/completions:', error?.message || error);
      lastCustomLlmError = { at: new Date().toISOString(), thrown: String(error?.message || error) };
      if (!res.headersSent) res.status(500).json({ error: 'custom_llm_failed' });
      else { try { res.end(); } catch { /* ignore */ } }
    }
  };

  // ElevenLabs may treat the configured custom-LLM URL as a BASE and append
  // "/chat/completions" itself, or use it verbatim. Mount the handler on every
  // plausible path so the agent reaches us regardless of that convention.
  app.post('/api/ai/elevenlabs/llm/chat/completions', elevenLlmLimiter, elevenCustomLlmHandler);
  app.post('/api/ai/elevenlabs/llm', elevenLlmLimiter, elevenCustomLlmHandler);
  app.post('/api/ai/elevenlabs/llm/chat/completions/chat/completions', elevenLlmLimiter, elevenCustomLlmHandler);

  // Custom-LLM diagnostics, for remote debugging. Guarded by the same secret
  // ElevenLabs uses, so only callers with the shared secret can read it.
  let lastCustomLlmError = null;
  const customLlmStats = { hits: 0, authFails: 0, lastHitAt: null, lastResult: null, lastAuthFail: null, lastPath: null, lastRetrievalChars: null, lastTokenFound: null, lastUserIdFound: null, lastScreenChars: null, lastGroundingChars: null };
  app.get('/api/ai/elevenlabs/llm/_debug', elevenLlmLimiter, (req, res) => {
    const expected = process.env.ELEVENLABS_LLM_SECRET;
    if (!expected || String(expected).length < 32) {
      return res.status(503).json({ error: 'Custom LLM not configured.' });
    }
    const presented = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!expected || !timingSafeEqualStr(presented, expected)) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ customLlmStats, lastCustomLlmError, configuredAgentUrlHint: '/api/ai/elevenlabs/llm (base) — EL appends /chat/completions' });
  });
}
