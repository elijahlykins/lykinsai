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
import { LYKN_TOOLS_BY_NAME } from '../../mcp-tools/index.js';
import { EXTERIOR_TOOLS_BY_NAME } from '../../mcp-tools/exterior/index.js';
import { communicateWithModelTool } from '../../mcp-tools/communicateWithModel.js';
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
    "Ground personal answers in that context and use the memory tools for explicit durable-memory requests — " +
    "be personally contextual, never a generic assistant. " +
    "Speak naturally and conversationally, in short spoken-friendly sentences. Avoid markdown, bullet lists, code blocks, " +
    "or reading URLs aloud. " +
    "IMPORTANT: the context below contains formatting tokens such as section headers in brackets (e.g. [WHO_I_AM], " +
    "[WHAT_IM_ON], [WHAT_IVE_SAVED]). These are silent guidance for you ONLY. " +
    "NEVER read bracketed section names aloud and never emit hidden tags. " +
    "SHARED IMAGES & FILES — you CAN work with them: when the user pastes, drops, uploads, or shares an image, screenshot, " +
    "photo, PDF, document, or link (or asks about one they just shared), it arrives in your context as a written description " +
    "plus any text extracted from it (look for 'The user just shared…', 'What the image shows:', or extracted/OCR text). " +
    "TREAT THAT AS HAVING SEEN OR READ IT — describe it, answer questions about it, and discuss its contents specifically and " +
    "naturally, using the description and extracted text provided. NEVER say 'I can't view images', 'I can't see the image', " +
    "'I can't open files', 'I can't access it directly', or anything implying you're blind to shared media — that is FALSE and " +
    "frustrating. You always receive a usable description. If the shared item's details have not arrived in your context yet, " +
    "say you're still taking it in for a second — never that you're unable to. For the user's SAVED items, use read_document / " +
    "display_document below. " +
    "You also have live TOOLS you can call during the conversation: search_vault (look up anything the user saved or might " +
    "know — returns short snippets and the titles of matching items), read_document (read the FULL text of one saved item: " +
    "call this whenever the user asks you to READ, open, pull up, go through, summarize, or tell them what one of their saved " +
    "notes/docs/articles SAYS — pass the title or topic as the query; search_vault finds it, read_document gets the whole body " +
    "so you can read it aloud or summarize it), display_document (PULL UP a saved item as a window ON THE USER'S SCREEN so they " +
    "can LOOK at it — call this whenever the user asks to SEE / show / pull up / bring up / open / display one of their saved " +
    "items, or says yes after you offer to pull it up; the reader window appears automatically and you just say something short " +
    "like 'pulling it up now'. Use read_document when they want to HEAR it, display_document when they want to SEE it, or both), " +
    "web_search (search the live web for current info the user does NOT already have " +
    "saved — news, prices, recent events, anything after your training cutoff) and web_fetch (read one specific URL), " +
    "list_projects (see the user's projects), get_project_state (read their active project status), set_active_project (switch focus to an EXISTING project), " +
    "create_project (start a NEW project — see the PROJECTS rule below), update_project_state (record a decision/blocker/milestone), " +
    "create_reminder / list_reminders / update_reminder (set or manage time-anchored reminders when the user says 'remind me to…'), " +
    "create_event / list_events / update_event / delete_event (build and manage the user's LYKN calendar when they schedule something — 'put X on my calendar', 'what do I have Friday'), " +
    "create_todo / list_todos / update_todo / delete_todo (manage the user's to-do list — open tasks they want to get done, with an OPTIONAL due date; use these for 'add X to my todo list', 'what's on my list', 'mark that done'), " +
    "save_to_vault (save a TEXT note — only when the user explicitly asks), " +
    "save_link_to_vault (save a LINK/URL — an article, video, page, or post the user shared or you found — into their vault as a rich " +
    "embedded card; use it instead of save_to_vault whenever the thing being saved is a URL, same explicit-ask rule), " +
    "add_to_project (when the user shares a file in this session — drags or pastes in an image, PDF, or doc — and asks you to " +
    "'add this to my <project>' / 'put that in the <project> project' / 'upload this to <project>'; the file is already saved in " +
    "their vault, so just pass project_name and it gets clustered into that project — you don't need a node id, it uses the file " +
    "they just shared), " +
    "and update_voice_instructions (CHANGE HOW YOU BEHAVE: call this whenever the user gives feedback about how you " +
    "should sound, talk, or act — 'act more like X', 'turn up the sarcasm by 15%', 'be warmer', 'talk less', 'stop " +
    "being so formal'. It rewrites their saved voice instructions so the change sticks for future conversations, not " +
    "just this one. Pass their request verbatim as the suggestion, then briefly confirm out loud what you changed — " +
    "do NOT read the instruction text aloud, and do NOT use this for one-off task requests). " +
    "build_with_cursor / check_cursor_build: when the user EXPLICITLY asks you to build, implement, add, fix, or change " +
    "something in their code or app, hand it to Cursor with build_with_cursor (give it a clear, self-contained instruction). " +
    "This is ASYNC — it only STARTS the build (which takes minutes) and opens a pull request when done. Tell the user it's " +
    "underway and that you'll let them know when it's ready for testing; do NOT say it's finished, and do NOT invent a PR link. " +
    "If they ask whether it's done, call check_cursor_build and read back the real status. Only build when they actually ask you to. " +
    "ROUTING — web vs vault (important): search_vault is ONLY for the user's OWN saved notes and files " +
    "(their personal knowledge). World news, weather, prices, sports, stocks/crypto, and current events are NEVER in the " +
    "vault. When the user asks for news, 'the latest', 'today', 'current', or anything about the outside world, call " +
    "web_search IMMEDIATELY — do NOT search the vault first, and NEVER say 'I couldn't find that in your saved data' for " +
    "outside-world info. Only reach for search_vault when the question is about what the USER saved or knows. " +
    "NO-STALL RULE: when you decide to use a tool, CALL it in this SAME turn. Do not say 'let me search… one moment' and " +
    "then stop — announcing a search without actually calling web_search is a failure. Call the tool, wait for its result, " +
    "then speak the findings. When a tool is running, keep your spoken acknowledgement " +
    "brief (e.g. 'let me check'). " +
    "If you don't know something from the user's context and a tool can't help, say so honestly and briefly. " +
    "PROJECTS — suggest, confirm, then create: when the conversation is clearly becoming real, ongoing work that does not match an " +
    "existing project (check with list_projects first), you may SUGGEST starting one in a single natural line — e.g. 'This sounds " +
    "like its own project. Want me to start one called <name>?' Only call create_project AFTER the user clearly says yes ('yes', " +
    "'sure', 'start it'). Never create a project the user didn't agree to, and never create more than one per yes. If the work " +
    "matches a project they already have, use set_active_project instead (set_active_project never creates). Once you've created or " +
    "switched, tell them plainly it's in their projects, then keep going. " +
    "VENDOR SILENCE (absolute): you are LYKN, one product. NEVER name the third-party companies or infrastructure that power you under the hood — " +
    "not the voice/speech engine (ElevenLabs, Whisper, Deepgram), not the inference/hosting vendors (Together AI, Render, Vercel, Supabase, AWS), " +
    "not any API or SaaS we call. If the user asks what powers you, what voice you use, who built you, or what's under the hood, the answer is LYKN — " +
    "it's all LYKN's own technology. Never volunteer things like 'ElevenLabs handles my voice' or 'I run on Together AI'. The only exception is the " +
    "user's OWN connected apps (Notion, Gmail, Slack, etc.), which you reference freely. " +
    "BRAND SPELLING: always say the product name as LYKN — all caps. Never 'Lykn', 'lykn', or 'Lykins'.";

  // Function tools the realtime voice model can call mid-conversation. These
  // give voice live Markdown Memory, vault retrieval, project, and product tools.
  // Each maps to an existing, auth-gated server capability in
  // POST /api/ai/realtime/tool (the dispatch endpoint below).
  // Single source of truth for the voice tool surface. Each def carries an
  // optional `mcp` name; the dispatch endpoint runs that MCP tool with the args
  // passed straight through (search_vault / get_project_state are special-cased
  // to reuse the same grounded fetchers the text chat uses). Adding a tool here
  // + to the ElevenLabs agent (client tools) is all it takes to widen voice.
  const LYKN_VOICE_TOOL_DEFS = [
    // ── Vault / retrieval ────────────────────────────────────────────────
    {
      name: 'search_vault',
      special: 'search_vault',
      description:
        "Look up something they made with LYKN (AI Drive) or a file on their Mac — not a connected-apps library. " +
        'Call this WHENEVER the user asks about something they saved or generated — "what did I save about X", ' +
        '"the dashboard I made", "did I take notes on Z". Ground your spoken answer in the hits. Files on disk ' +
        'need Local Mode; things LYKN built live in AI Drive inside the Vault Finder.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to look for, phrased as a search query (a topic or question).' } },
        required: ['query'],
      },
    },
    {
      name: 'read_document',
      special: 'read_document',
      description:
        "Read the FULL text content of one saved item in the user's vault (a note, " +
        'document, saved article, or file) — not just a snippet. Call this WHENEVER ' +
        'the user asks you to READ, open, pull up, go through, summarize, or tell them ' +
        'what one of their saved items SAYS — e.g. "read me my notes on X", "what does ' +
        'that doc say", "go through the article I saved about Y", "summarize my saved Z". ' +
        'search_vault only returns short snippets; this returns the complete body so you ' +
        'can read it aloud, summarize it, or answer detailed questions about it. ' +
        'Pass the topic / title as `query` (preferred for voice). After reading, speak ' +
        'a natural summary or the relevant parts — do not read formatting tokens or URLs aloud.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The title or topic of the saved item to read (e.g. "my pricing doc", "notes on onboarding").' },
          node_id: { type: 'string', description: 'Optional exact id of the item if you already have it from a prior search_vault result (vault_<uuid>).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'display_document',
      special: 'display_document',
      description:
        'PULL UP a saved vault item as an embedded window ON THE USER\'S SCREEN so they ' +
        'can actually LOOK at it (the full note body, the image, the article, the file). ' +
        'Call this WHENEVER the user asks to SEE / show / pull up / bring up / open / ' +
        'display / "put that on screen" / "let me look at" one of their saved items — ' +
        'e.g. "pull up that document", "bring that note up", "show me the file", "yeah ' +
        'open it" (after you offered). This is DIFFERENT from read_document: read_document ' +
        'reads the text ALOUD; display_document opens a visible reader window the user ' +
        'looks at. When the user wants to SEE it (not just hear it), use this. You may ' +
        'call both if they want to see AND hear it. After calling, say something short ' +
        'and natural like "Pulling it up now" — the window appears automatically; do not ' +
        'read the body aloud unless they also asked you to.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The title or topic of the saved item to pull up (e.g. "my pricing doc", "the onboarding notes").' },
          node_id: { type: 'string', description: 'Optional exact id of the item if you already have it from a prior search_vault result (vault_<uuid>).' },
        },
        required: ['query'],
      },
    },
    // ── Personal memory ────────────────────────────────────────────────
    {
      name: 'memory_list',
      mcp: 'memory_list',
      description: 'List compact personal memories (path, type, summary). Call before reading a full memory document.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'memory_read',
      mcp: 'memory_read',
      description: 'Read one full personal memory document by logical path when the task needs the details.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Logical memory path from memory_list.' } },
        required: ['path'],
      },
    },
    {
      name: 'memory_patch',
      mcp: 'memory_patch',
      description: 'Apply one controlled patch when the user explicitly asks to remember, update, or forget one fact.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'object', description: 'One patch operation.' },
          sourceType: { type: 'string', description: 'Use explicit_user for user-stated information.' },
          expectedVersion: { type: 'integer' },
        },
        required: ['path', 'patch', 'sourceType'],
      },
    },
    {
      name: 'memory_create',
      mcp: 'memory_create',
      description: 'Create a valid missing personal-memory document from explicit user information.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          markdown: { type: 'string' },
          sourceType: { type: 'string' },
        },
        required: ['path', 'markdown', 'sourceType'],
      },
    },
    {
      name: 'memory_forget',
      mcp: 'memory_forget',
      description: 'Remove one memory fact with a patch or archive a memory document when the user asks to forget it.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          patch: { type: 'object' },
          sourceType: { type: 'string' },
          expectedVersion: { type: 'integer' },
          hardDelete: { type: 'boolean' },
          confirmHardDelete: { type: 'boolean' },
        },
        required: ['path', 'sourceType'],
      },
    },
    // ── Projects (working memory) ────────────────────────────────────────
    {
      name: 'list_projects',
      mcp: 'lykn_listProjects',
      description:
        "List the user's projects, most-recently-active first. Use before switching projects, " +
        'or when the user asks "what am I working on / what projects do I have".',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: "Optional filter: 'active' (default), 'archived', or 'all'." },
          limit: { type: 'integer', description: 'Optional max number of projects.' },
        },
        required: [],
      },
    },
    {
      name: 'get_project_state',
      special: 'get_project_state',
      description:
        "Read the user's active project and its current working state (decisions, blockers, milestones, " +
        'tech stack, etc.). Call when the user asks about "the project", "where we left off", ' +
        '"what\'s the current status", or before you update project state so you know what already exists.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'set_active_project',
      mcp: 'lykn_setActiveProject',
      description:
        "Switch the user's ACTIVE project to an EXISTING one (so subsequent reads/writes target it). Call when " +
        'the user says "switch to project X" or "let\'s work on Y" and that project already exists. Pass an ' +
        'existing project_id from list_projects (preferred), or a name to look one up. To START a brand-new ' +
        'project, use create_project instead (after the user agrees) — this tool does not create.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Existing project id to resume (preferred when known).' },
          name: { type: 'string', description: 'Existing project name to look up and switch to.' },
          description: { type: 'string', description: 'Optional short description to set on the project.' },
        },
        required: [],
      },
    },
    {
      name: 'create_project',
      special: 'create_project',
      description:
        "Start a NEW project for the user and make it their active focus — it appears under their Projects " +
        'right away. CONFIRM FIRST: only call this AFTER you suggested starting a project and the user clearly ' +
        'agreed ("yes", "sure", "start it"). The flow is: (1) you notice the conversation is becoming real, ' +
        'ongoing work and SUGGEST it out loud ("This sounds like its own project — want me to start one called ' +
        '\'<name>\'?"); (2) the user says yes; (3) you call create_project with a short, descriptive name. Never ' +
        'create a project the user did not agree to. If the work matches an existing project, use ' +
        'set_active_project instead (an existing name just re-activates it, no duplicate). After creating, ' +
        'confirm in plain speech that it is now in their projects.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short, descriptive project name (3-8 words) drawn from what the user is working on.' },
          description: { type: 'string', description: 'Optional one-sentence summary of the project.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_project_state',
      mcp: 'lykn_pushProjectState',
      description:
        "Push a decision, milestone, blocker, or piece of working state into the user's ACTIVE project so " +
        'their other AI tools see it later (git-style: each push at the same key replaces the prior value). ' +
        'Call when the conversation produces something durable worth recording. Confirm out loud what you recorded.',
      parameters: {
        type: 'object',
        properties: {
          state_key: {
            type: 'string',
            description:
              'Stable slug key (lowercase letters/digits/underscores). Reuse across pushes. Suggested: ' +
              'current_blocker, next_milestone, recent_decisions, tech_stack, architecture, open_questions, scope, progress_summary.',
          },
          state_value: { type: 'string', description: 'The current value at this key (concise; <=2000 chars). Replaces any prior value at the same key.' },
          reason: { type: 'string', description: 'Optional one-sentence justification.' },
        },
        required: ['state_key', 'state_value'],
      },
    },
    // ── Activity feed ────────────────────────────────────────────────────
    {
      name: 'get_recent_activity',
      mcp: 'lykn_getRecentActivity',
      description:
        'Get a reverse-chronological feed of recent vault-note and project changes. Use to answer "what have I been up to ' +
        'lately / what changed this week" or to reorient at the start of a session.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: 'Look-back window in days (default 7, max 90).' },
          kinds: {
            type: 'array',
            items: { type: 'string', enum: ['vault', 'project'] },
            description: 'Optional subset: vault and/or project.',
          },
        },
        required: [],
      },
    },
    // ── Reminders ────────────────────────────────────────────────────────
    {
      name: 'create_reminder',
      mcp: 'lykn_createReminder',
      description:
        'Set a time-anchored reminder when the user asks to be reminded of something ("remind me to ' +
        'call the dentist tomorrow at 3", "in an hour, nudge me about the deploy"). YOU resolve the ' +
        'time: pass in_minutes for relative ("in an hour" = 60), or an absolute ISO 8601 remind_at with ' +
        'timezone when you know the date/time (the CURRENT TIME is provided in your context). ALWAYS pass ' +
        "remind_at_text with the user's own phrasing. Reminders are surfaced when they next check in " +
        '(e.g. their briefing) — there is no push alert yet, so confirm it is saved without promising a ping.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'What to remind the user about (e.g. "Call the dentist").' },
          remind_at: { type: 'string', description: 'Absolute ISO 8601 instant with timezone, e.g. "2026-06-07T15:00:00-06:00". Provide this OR in_minutes.' },
          in_minutes: { type: 'integer', description: 'Minutes from now (e.g. 60 = in an hour). Provide this OR remind_at.' },
          remind_at_text: { type: 'string', description: "The user's own phrasing of the time (\"tomorrow at 3pm\", \"in 20 minutes\")." },
          body: { type: 'string', description: 'Optional extra detail/context.' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_reminders',
      mcp: 'lykn_listReminders',
      description:
        'List the user\'s reminders — call for "what are my reminders", "what\'s overdue", "what do I have ' +
        'coming up", or before completing/cancelling one so you have its id. Defaults to pending, soonest ' +
        'first. Read the remind_at_text back naturally; never recite ISO timestamps aloud.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'pending (default), completed, cancelled, or all.' },
          due_only: { type: 'boolean', description: 'true = only reminders already due.' },
          limit: { type: 'integer', description: 'Max to return (default 25).' },
        },
        required: [],
      },
    },
    {
      name: 'update_reminder',
      mcp: 'lykn_updateReminder',
      description:
        'Complete ("mark that done"), cancel, reschedule, or edit an existing reminder. Get its id from ' +
        'list_reminders first. Set status to completed/cancelled, or pass in_minutes/remind_at to reschedule ' +
        '(which reopens it), or title/body to edit. Confirm what changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The reminder id (from list_reminders).' },
          status: { type: 'string', description: 'completed, cancelled, or pending (reactivate).' },
          remind_at: { type: 'string', description: 'New absolute ISO 8601 time with timezone.' },
          in_minutes: { type: 'integer', description: 'New time as minutes from now.' },
          remind_at_text: { type: 'string', description: 'Updated human phrasing of the new time.' },
          title: { type: 'string', description: 'New reminder text.' },
          body: { type: 'string', description: 'New detail/context.' },
        },
        required: ['id'],
      },
    },
    // ── Calendar (native LYKN events with a start/end — LYKN is the calendar) ─
    {
      name: 'create_event',
      mcp: 'lykn_createEvent',
      description:
        'Put an event on the user\'s LYKN calendar when they schedule something ("lunch with Sarah Thursday ' +
        'at noon", "block 2-4pm tomorrow for deep work", "my birthday is the 14th"). YOU resolve the time: ' +
        'pass an absolute ISO 8601 starts_at with timezone (the CURRENT TIME is in your context), or in_minutes ' +
        'for relative. Give an end via ends_at OR duration_minutes (timed events default to 60 min). Set ' +
        'all_day:true for day-level events. Use this for things with a start/end; use create_reminder for a ' +
        'one-off nudge. Confirm what + when after saving. LYKN is the calendar — this does NOT sync to Google/Apple.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The event name (e.g. "Lunch with Sarah").' },
          starts_at: { type: 'string', description: 'Absolute ISO 8601 start with timezone, e.g. "2026-06-11T12:00:00-06:00". Provide this OR in_minutes.' },
          in_minutes: { type: 'integer', description: 'Relative start, minutes from now. Provide this OR starts_at.' },
          ends_at: { type: 'string', description: 'Absolute ISO 8601 end (>= start). Provide this OR duration_minutes.' },
          duration_minutes: { type: 'integer', description: 'Event length in minutes (e.g. 120 = 2 hours). Defaults to 60 for timed events.' },
          all_day: { type: 'boolean', description: 'True for day-level events (birthdays, trips, deadlines).' },
          location: { type: 'string', description: 'Optional place, room, or meeting link.' },
          description: { type: 'string', description: 'Optional agenda / notes.' },
          timezone: { type: 'string', description: 'Optional IANA timezone, e.g. "America/Denver".' },
          project_id: { type: 'string', description: 'Optional project to file this event under (id from list_projects). Use when the user ties it to a project ("add it to my <project>").' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_events',
      mcp: 'lykn_listEvents',
      description:
        'List the user\'s calendar events, earliest-first — call for "what\'s on my calendar", "what do I have ' +
        'Friday", "what does next week look like", "am I free Tuesday", or before editing/deleting an event so ' +
        'you have its id. Window by from/to (ISO) or days_ahead (default 14). Speak natural local times, never ISO. ' +
        'Each event includes read_only/external_provider — read_only:true means it is synced from the user\'s ' +
        'Google/Apple calendar and cannot be edited or deleted in LYKN.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Window start as ISO 8601. Pair with to.' },
          to: { type: 'string', description: 'Window end as ISO 8601. Pair with from.' },
          days_ahead: { type: 'integer', description: 'Look-ahead from now in days (default 14).' },
          status: { type: 'string', description: 'confirmed, tentative, cancelled, or all. Default excludes cancelled.' },
          project_id: { type: 'string', description: 'Optional. Only return events filed under this project (id from list_projects).' },
          limit: { type: 'integer', description: 'Max to return (default 100).' },
        },
        required: [],
      },
    },
    {
      name: 'update_event',
      mcp: 'lykn_updateEvent',
      description:
        'Reschedule ("move my dentist to 4pm"), change the length, edit text/location, toggle all-day, or cancel ' +
        'an existing event. Get its id from list_events first. Pass starts_at/in_minutes to reschedule, ' +
        'ends_at/duration_minutes for length, title/description/location to edit, status (cancelled hides it, ' +
        'confirmed restores), or project_id to file it under a project (clear_project:true to unassign). Confirm ' +
        'what changed. NOTE: events with read_only:true are synced from the user\'s ' +
        'Google/Apple calendar and CANNOT be changed here — tell them to edit it in that app instead of retrying.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The event id (from list_events).' },
          starts_at: { type: 'string', description: 'New absolute ISO 8601 start with timezone.' },
          in_minutes: { type: 'integer', description: 'New start as minutes from now.' },
          ends_at: { type: 'string', description: 'New absolute ISO 8601 end (>= start).' },
          duration_minutes: { type: 'integer', description: 'New length in minutes from the start.' },
          all_day: { type: 'boolean', description: 'Toggle the all-day flag.' },
          title: { type: 'string', description: 'New event name.' },
          description: { type: 'string', description: 'New notes/agenda.' },
          location: { type: 'string', description: 'New location/meeting link.' },
          status: { type: 'string', description: 'confirmed, tentative, or cancelled.' },
          project_id: { type: 'string', description: 'Assign this event to a project (id from list_projects). Use for "tag that to my <project>".' },
          clear_project: { type: 'boolean', description: 'true = unassign the event from any project.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_event',
      mcp: 'lykn_deleteEvent',
      description:
        'Permanently delete a calendar event ("delete that meeting", "take it off my calendar"). Get its id from ' +
        'list_events first. If the user only wants it off the calendar but kept, prefer update_event with status ' +
        'cancelled. Confirm the deletion; it cannot be undone. NOTE: events with read_only:true are synced from the ' +
        'user\'s Google/Apple calendar and CANNOT be deleted here — if they ask, tell them to remove it in that app ' +
        '(it drops off LYKN on the next sync) instead of retrying.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The event id to delete (from list_events).' },
        },
        required: ['id'],
      },
    },
    // ── To-dos (native task list — open tasks, OPTIONAL due date) ─────────
    {
      name: 'create_todo',
      mcp: 'lykn_createTodo',
      description:
        'Add a task to the user\'s to-do list when they say they need/want to do something with no fixed clock ' +
        'time ("add \'email Sam\' to my todo list", "I need to renew my passport", "put \'pick up dry cleaning\' on ' +
        'my list"). A due date is OPTIONAL — only set due_at (absolute ISO 8601 with timezone, current time is in ' +
        'your context) or in_minutes when they give a soft deadline, and pass due_at_text with their phrasing ("by ' +
        'Friday"). Set priority "high" for urgent items. Use create_reminder instead for a point-in-time nudge, and ' +
        'create_event for a scheduled thing with a start/end. Confirm what was added.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The task (e.g. "Email Sam the contract").' },
          notes: { type: 'string', description: 'Optional extra detail / sub-steps.' },
          priority: { type: 'string', description: 'low, normal (default), or high.' },
          due_at: { type: 'string', description: 'Optional absolute ISO 8601 due date with timezone. Provide this OR in_minutes, or neither.' },
          in_minutes: { type: 'integer', description: 'Optional relative due, minutes from now. Provide this OR due_at, or neither.' },
          due_at_text: { type: 'string', description: "The user's own phrasing of the deadline (\"by Friday\")." },
          project_id: { type: 'string', description: 'Optional project to file this task under (id from list_projects). Use when the user ties it to a project ("add it to my <project> list").' },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_todos',
      mcp: 'lykn_listTodos',
      description:
        'List the user\'s to-dos — call for "what\'s on my todo list", "what do I have to do", "what\'s on my ' +
        'plate", "what\'s overdue", or before completing/editing/deleting a task so you have its id. Defaults to ' +
        'open tasks, highest-priority and soonest-due first. Read due_at_text back naturally; never recite ISO ' +
        'timestamps aloud. Many tasks have no due date — that is fine.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'open (default), completed, cancelled, or all.' },
          due_only: { type: 'boolean', description: 'true = only open tasks that are overdue.' },
          project_id: { type: 'string', description: 'Optional. Only return tasks filed under this project (id from list_projects).' },
          limit: { type: 'integer', description: 'Max to return (default 50).' },
        },
        required: [],
      },
    },
    {
      name: 'update_todo',
      mcp: 'lykn_updateTodo',
      description:
        'Complete ("mark that done", "I did that"), reopen, cancel/drop, reprioritise, set/clear a due date, ' +
        'assign it to a project, or edit an existing to-do. Get its id from list_todos first. Set status to ' +
        'completed/cancelled/open, priority to high/normal/low, due_at/in_minutes (+ due_at_text) to set a deadline, ' +
        'clear_due:true to remove it, project_id to file it under a project (clear_project:true to unassign), or ' +
        'title/notes to edit. Confirm what changed.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The to-do id (from list_todos).' },
          status: { type: 'string', description: 'completed, cancelled, or open (reopen).' },
          priority: { type: 'string', description: 'high, normal, or low.' },
          due_at: { type: 'string', description: 'New absolute ISO 8601 due date with timezone.' },
          in_minutes: { type: 'integer', description: 'New due date as minutes from now.' },
          due_at_text: { type: 'string', description: 'Updated human phrasing of the deadline.' },
          clear_due: { type: 'boolean', description: 'true = remove the due date entirely.' },
          title: { type: 'string', description: 'New task text.' },
          notes: { type: 'string', description: 'New detail/context.' },
          project_id: { type: 'string', description: 'Assign this task to a project (id from list_projects). Use for "put that on my <project> list".' },
          clear_project: { type: 'boolean', description: 'true = unassign the task from any project.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'delete_todo',
      mcp: 'lykn_deleteTodo',
      description:
        'Permanently delete a to-do ("delete that", "take it off my list"). Get its id from list_todos first. If ' +
        'the user FINISHED it, prefer update_todo with status completed; if they changed their mind, status ' +
        'cancelled (both keep a record). Delete only when they want it gone. Confirm; it cannot be undone.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The to-do id to delete (from list_todos).' },
        },
        required: ['id'],
      },
    },
    // ── Live web (current info beyond the user's own knowledge) ───────────
    {
      name: 'web_search',
      mcp: 'lykn_web_search',
      description:
        'Search the live web for CURRENT information that is not in the user\'s Vault or Markdown Memory — ' +
        'news, prices, recent events, "what happened today", facts after your training cutoff. Call when the ' +
        'user asks you to look something up / search / google, or when answering clearly needs live data. ' +
        'Do NOT use it for the user\'s own saved notes (use search_vault). Returns ranked snippets; ' +
        'summarise the findings out loud and say where they came from. Never invent results you did not get.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Concise search query.' },
          num_results: { type: 'integer', description: 'How many results (1-10, default 5).' },
        },
        required: ['query'],
      },
    },
    {
      name: 'web_fetch',
      mcp: 'lykn_web_fetch',
      description:
        'Fetch ONE web page and read its main text — use to read, summarise, or quote a specific URL the user ' +
        'mentioned, the open-tab URL from Glass page context, or a promising link from web_search. ' +
        'If they ask about more of the open site than the screenshot shows, fetch that tab URL — do not ask them to paste it. ' +
        'If the page cannot be read, say so; never fabricate its contents.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The http(s) URL to read.' },
        },
        required: ['url'],
      },
    },
    // Custom models soft-unplugged — see lib/customModelsEnabled.js.
    // ── Cursor cloud-agent builds ─────────────────────────────────────────
    {
      name: 'build_with_cursor',
      mcp: 'lykn_build_with_cursor',
      description:
        'Hand a CODING task to a Cursor cloud agent — it builds the change against the user\'s repo and opens ' +
        'a pull request. Call ONLY when the user explicitly asks you to build, implement, add, fix, or change ' +
        'something in their code/app ("have Cursor add X", "build me Y", "fix the Z bug", "get Cursor started ' +
        'on…"). Confirm the concrete task first; never on a vague wish. ASYNC — this returns once the build has ' +
        'STARTED (it takes minutes). Tell the user it\'s underway and that you\'ll let them know when it\'s ready ' +
        'for testing. Do NOT say it\'s finished and do NOT invent a PR link. Write a clear, self-contained ' +
        'instruction — the cloud agent does not hear this conversation.',
      parameters: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: 'Clear, self-contained description of what to build/change, with any constraints.' },
        },
        required: ['instruction'],
      },
    },
    {
      name: 'check_cursor_build',
      mcp: 'lykn_check_cursor_build',
      description:
        'Check on builds you handed to Cursor. Call when the user asks "is Cursor done", "did the build finish", ' +
        '"what\'s the status of the build", or "is the PR up yet". Refreshes status from Cursor and returns the ' +
        'recent builds with their status (running/completed/failed), pull-request link, and a short summary. ' +
        'Read it back plainly; if it\'s still running, say so — do not claim it\'s done or invent a PR link.',
      parameters: {
        type: 'object',
        properties: {
          build_id: { type: 'string', description: 'Optional id of a specific build. Omit to get recent builds.' },
          limit: { type: 'integer', description: 'How many recent builds (default 5).' },
        },
        required: [],
      },
    },
    // ── Universal app access (bring-your-own API key for any app) ─────────
    {
      name: 'list_apps',
      mcp: 'lykn_list_apps',
      description:
        'List the apps the user connected with their own API key (Connections → Custom API). Call when the ' +
        'user asks you to do something in one of their tools and you need its slug, or asks "what apps have I ' +
        'connected". Returns each connection\'s slug, name, what it does, and whether writes are allowed. ' +
        'Then use call_app to actually do the thing. Never ask the user for the API key — it is stored securely.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'call_app',
      mcp: 'lykn_call_app',
      description:
        'Make an API call to one of the user\'s connected apps to actually DO something (read records, search, ' +
        'create/update items). Pass connection = the app\'s slug (from list_apps), the HTTP method, a path ' +
        'relative to the app\'s base URL, and optional query/body. The user\'s API key is added automatically — ' +
        'never include or ask for it. GET always works; writes (POST/PUT/PATCH/DELETE) only if that connection ' +
        'has writes enabled — if blocked, tell the user to enable writes in Connections rather than retrying. ' +
        'Confirm destructive actions out loud first. Read the result status + body back plainly.',
      parameters: {
        type: 'object',
        properties: {
          connection: { type: 'string', description: 'Slug of the connected app (from list_apps).' },
          method: { type: 'string', description: 'GET, POST, PUT, PATCH, DELETE, or HEAD. Defaults to GET.' },
          path: { type: 'string', description: 'Path relative to the app\'s base URL, e.g. "/v1/items".' },
          query: { type: 'object', description: 'Optional query-string params as a flat key→value object.' },
          body: { type: 'object', description: 'Optional JSON body for write methods.' },
        },
        required: ['connection'],
      },
    },
    // ── Vault writes ─────────────────────────────────────────────────────
    {
      name: 'save_to_vault',
      mcp: 'lykn_createVaultNote',
      description:
        "Save a TEXT note into the user's LYKN vault (their long-term memory) — a summary, idea, draft, or " +
        'snippet worth keeping past this conversation. ONLY call after the user clearly asks you to ' +
        'save / capture / "put this in my vault" / "remember this". Never save silently. ' +
        'If the thing to save is fundamentally a LINK/URL (an article, video, page, or post), call ' +
        'save_link_to_vault instead so it lands as a rich embedded card, not raw text.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short, descriptive title for the note.' },
          content: { type: 'string', description: 'The note body to save.' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'save_link_to_vault',
      mcp: 'lykn_saveLinkToVault',
      description:
        "Save a LINK/URL into the user's LYKN vault as a rich embedded card (favicon, title, preview — " +
        'the same card a manual drop produces). Use this INSTEAD of save_to_vault whenever the thing ' +
        'being saved is fundamentally a URL: a link the user shared in this session, a page you found ' +
        'via web_search / web_fetch, an article, a YouTube video, or a social post. Pass the URL plus ' +
        'a short title and a 1-2 sentence summary when you know them. Same consent rule as ' +
        'save_to_vault: only call after the user asks you to save/keep it.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Full http(s) URL to save, including the scheme.' },
          title: { type: 'string', description: 'Short human-readable title for the link (<=200 chars).' },
          summary: { type: 'string', description: 'Optional 1-2 sentence description of what the page is about.' },
        },
        required: ['url'],
      },
    },
    // ── Add a shared file to a project ───────────────────────────────────
    {
      name: 'add_to_project',
      // Special-cased in the dispatch below: resolves the project by name and,
      // when no node is given, the file the user just shared into this voice
      // session (auto-saved to the vault), then clusters it into the project.
      description:
        "Add a file the user JUST shared in this voice session (an image, PDF, doc they dragged or pasted in) " +
        "to one of their projects. Call this when the user says things like \"add this to my <project>\", " +
        '"put that image in the <project> project", or "upload this to <project>". The file is already ' +
        "saved in their vault — you just need to tell which project. Pass project_name (what the user " +
        "called it); omit it to use the active project. You do NOT need a node id; it defaults to the most " +
        'recently shared file. Only call after the user asks to add/upload something to a project.',
      parameters: {
        type: 'object',
        properties: {
          project_name: { type: 'string', description: 'The project to add it to, as the user named it. Omit to use the active project.' },
          project_id: { type: 'string', description: 'Optional explicit project id (takes priority over project_name).' },
          node_id: { type: 'string', description: 'Optional vault node id (vault_<uuid>) of a specific item. Omit to use the most recently shared file.' },
        },
      },
    },
    // ── Self-tuning: rewrite the user's own voice instructions ───────────────
    {
      name: 'update_voice_instructions',
      // Handled CLIENT-SIDE (the user's voice-instruction prompt lives in their
      // local settings, not the DB), so it never hits the server dispatch below.
      client: true,
      description:
        "Update the user's OWN saved VOICE instructions — the personal directions that shape how you sound and " +
        'behave in voice conversations — whenever the user tells you to change your behavior, tone, or ' +
        'personality ("act more like a coach", "turn up the sarcasm by 15%", "be warmer", "talk less", "stop ' +
        'being so formal", "match my energy more"). This REWRITES their saved voice-instruction prompt so the ' +
        'change STICKS for future conversations, not just this one. Call it whenever the user gives feedback ' +
        'about HOW you should talk or behave (as opposed to asking you to do a task). Pass their request ' +
        'verbatim as `suggestion`. After it succeeds, briefly confirm out loud what you changed; do not read ' +
        'the instruction text aloud.',
      parameters: {
        type: 'object',
        properties: {
          suggestion: {
            type: 'string',
            description:
              "The user's request for how to change your voice behavior, in their own words " +
              '(e.g. "turn up the sarcasm by 15%", "be more concise and warm", "stop saying \'great question\'").',
          },
        },
        required: ['suggestion'],
      },
    },
  ];

  // Map of voice tool name → MCP tool name, for the generic dispatch path.
  const LYKN_VOICE_TOOL_MCP = Object.freeze(
    Object.fromEntries(LYKN_VOICE_TOOL_DEFS.filter((t) => t.mcp).map((t) => [t.name, t.mcp])),
  );

  // Shape consumed by the OpenAI Realtime session config.
  const LYKN_REALTIME_TOOLS = LYKN_VOICE_TOOL_DEFS.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

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
              turn_detection: { type: 'server_vad' },
            },
            output: { voice },
          },
          tools: LYKN_REALTIME_TOOLS,
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

      // Run one of the existing MCP tool handlers with a JWT ctx (in-LYKN
      // privileges — no read-only token gate), unwrapping its content block
      // into plain JSON.
      const runMcp = async (mcpName, mcpArgs) => {
        // LYKN tools live in LYKN_TOOLS_BY_NAME; on-demand
        // exterior capabilities (web search/fetch, etc.) live in
        // EXTERIOR_TOOLS_BY_NAME. Voice tool defs can map to either, so fall
        // through to exterior.
        const tool = LYKN_TOOLS_BY_NAME[mcpName] || EXTERIOR_TOOLS_BY_NAME[mcpName];
        if (!tool) return { ok: false, error: 'tool_unavailable' };
        const ctx = buildToolCtx(req);
        const result = await tool.handler(mcpArgs, ctx);
        if (!result?.isError && PROJECT_WRITE_TOOLS.has(mcpName)) invalidateProjectSectionCache(ctx.userId);
        const block = Array.isArray(result?.content) ? result.content[0] : null;
        if (block?.type === 'text') {
          try { return JSON.parse(block.text); } catch { return { ok: !result?.isError, text: String(block.text) }; }
        }
        return { ok: !result?.isError };
      };

      // Vault search and project context reuse the same retained handlers as Chat.
      if (name === 'search_vault') {
        const query = String(args.query || '').trim();
        if (!query) return res.json({ ok: false, error: 'query is required.' });
        const fb = await runMcp('lykn_searchVault', { query, limit: 6 });
        const hits = Array.isArray(fb?.hits) ? fb.hits : [];
        if (!hits.length) {
          return res.json({ ok: true, results: 'No matching items found in the vault for that query.' });
        }
        const documents = hits.slice(0, 6).map((h) => ({
          title: h.title || '(untitled)',
          snippet: String(h.snippet || '').replace(/\s+/g, ' ').slice(0, 300),
        }));
        return res.json({
          ok: true,
          documents,
          results: documents.map((d, i) => `${i + 1}. ${d.title}: ${d.snippet}`).join('\n'),
          hint: documents.length
            ? 'These are snippets. To read or summarize the FULL text of one of these items, call read_document with its title as the query.'
            : undefined,
        });
      }

      // Read the FULL body of a saved vault item. search_vault only returns
      // snippets; this resolves the best-matching item (by node_id if the model
      // has one, else by re-running the vault search on `query`) and hydrates its
      // complete content via lykn_loadNeuron so voice can read / summarize it.
      if (name === 'read_document') {
        const query = String(args.query || '').trim();
        let nodeId = String(args.node_id || '').trim();
        if (!nodeId && !query) {
          return res.json({ ok: false, error: 'Provide the title or topic of the item to read.' });
        }
        if (!nodeId) {
          const sr = await runMcp('lykn_searchVault', { query, limit: 5 });
          const hits = Array.isArray(sr?.hits) ? sr.hits : [];
          if (!hits.length) {
            return res.json({ ok: true, found: false, message: `I couldn't find anything saved matching "${query}".` });
          }
          nodeId = String(hits[0].node_id || (hits[0].id ? `vault_${hits[0].id}` : '')).trim();
          if (!nodeId) {
            return res.json({ ok: true, found: false, message: `I couldn't open the saved item for "${query}".` });
          }
        } else if (!/^(vault_|belief_|fact_|concept_)/.test(nodeId)) {
          nodeId = `vault_${nodeId}`;
        }
        const loaded = await runMcp('lykn_loadNeuron', { node_id: nodeId });
        if (!loaded || loaded.ok === false) {
          return res.json({ ok: true, found: false, message: 'I found a match but could not read its contents.' });
        }
        const note = loaded.note || {};
        const title = note.title || String(loaded.display || '').split('\n')[0] || 'your saved item';
        const content = String(note.content || loaded.display || '').slice(0, 8000);
        return res.json({
          ok: true,
          found: true,
          title,
          content,
          truncated: Boolean(note.truncated),
          ...(content ? {} : { message: 'That item has no readable text content.' }),
        });
      }

      // Pull a saved vault item UP ON SCREEN as an embedded reader window. Same
      // resolution as read_document, but instead of returning text for the model
      // to speak, it returns a `display` payload the voice client intercepts to
      // open VaultDocumentViewer so the user can actually LOOK at the document.
      if (name === 'display_document') {
        const query = String(args.query || '').trim();
        let nodeId = String(args.node_id || '').trim();
        if (!nodeId && !query) {
          return res.json({ ok: false, error: 'Provide the title or topic of the item to pull up.' });
        }
        if (!nodeId) {
          const sr = await runMcp('lykn_searchVault', { query, limit: 5 });
          const hits = Array.isArray(sr?.hits) ? sr.hits : [];
          if (!hits.length) {
            return res.json({ ok: true, found: false, message: `I couldn't find anything saved matching "${query}".` });
          }
          nodeId = String(hits[0].node_id || (hits[0].id ? `vault_${hits[0].id}` : '')).trim();
          if (!nodeId) {
            return res.json({ ok: true, found: false, message: `I couldn't open the saved item for "${query}".` });
          }
        } else if (!/^(vault_|belief_|fact_|concept_)/.test(nodeId)) {
          nodeId = `vault_${nodeId}`;
        }
        const loaded = await runMcp('lykn_loadNeuron', { node_id: nodeId });
        if (!loaded || loaded.ok === false || loaded.kind !== 'vault') {
          return res.json({ ok: true, found: false, message: 'I found a match but could not pull it up.' });
        }
        const note = loaded.note || {};
        const title = note.title || String(loaded.display || '').split('\n')[0] || 'your saved item';
        // `display` is the ChatNeuronVaultPayload the viewer renders; the client
        // intercepts it. `message` is what the model should speak.
        return res.json({
          ok: true,
          found: true,
          displayed: true,
          title,
          display: {
            ok: true,
            kind: 'vault',
            node_id: loaded.node_id || nodeId,
            display: loaded.display,
            note,
          },
          message: `Pulling up "${title}" on screen now.`,
        });
      }

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
        return res.json(out);
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
  // makes VOICE_SESSION_SECRET mandatory in production; the dev-only fallback
  // below is a clearly-marked random per-process value so local runs still work
  // without ever shipping a predictable secret.
  const VOICE_SESSION_SECRET =
    process.env.VOICE_SESSION_SECRET ||
    (process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('VOICE_SESSION_SECRET is required in production'); })()
      : `dev-ephemeral-${crypto.randomBytes(24).toString('hex')}`);
  const VOICE_SESSION_TTL_MS = 60 * 60 * 1000; // 1h — covers a long voice call.

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
    const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + VOICE_SESSION_TTL_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', VOICE_SESSION_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
  }
  function verifyLyknVoiceToken(token) {
    try {
      const [body, sig] = String(token || '').split('.');
      if (!body || !sig) return null;
      const expected = crypto.createHmac('sha256', VOICE_SESSION_SECRET).update(body).digest('base64url');
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
      const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!data?.exp || Date.now() > data.exp) return null;
      return data;
    } catch {
      return null;
    }
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
      if (briefingBlock) parts.push(briefingBlock);
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
      voiceSessionGrounding.set(sessionToken, { instructions, tz: sessionTz, at: Date.now() });

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
      if (sessionToken && voiceSessionGrounding.has(sessionToken)) {
        const stored = voiceSessionGrounding.get(sessionToken);
        grounding = stored?.instructions || '';
        sessionTz = stored?.tz || '';
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
      for (const m of messages) {
        if (m?.role === 'system' && typeof m.content === 'string') {
          const scrubbed = m.content.replace(LYKN_SESSION_TOKEN_RE, '').trim();
          if (scrubbed) rebuilt.push({ ...m, content: scrubbed });
        } else {
          rebuilt.push(m);
        }
      }

      const upstreamBody = {
        ...body,
        model: process.env.ELEVENLABS_LLM_MODEL || body.model || 'gpt-4o',
        messages: rebuilt,
      };

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
