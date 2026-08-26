// ─── AI Call Catalog ────────────────────────────────────────────────────────
// Single source of truth for every place this app spends money on AI.
// Used by the admin dashboard to:
//   • Show "where exactly is the AI cost coming from?" at a glance
//   • Cross-reference live spend (by_action) against expected surfaces
//   • Surface optimization candidates (caching, downgrades, deduping)
//
// To add a new AI surface: add an object below. Keep `actionTypes` aligned
// with whatever string is passed to `logAiUsage({ actionType })` at the call
// site. If a surface emits multiple action_types (e.g. dynamic length-based
// classification), list them all — the dashboard sums spend across the set.
//
// `tier` field is a STATIC, not-yet-actual cost expectation. The dashboard
// also ranks live, so you can compare expected vs reality.

/**
 * @typedef {Object} AISurface
 * @property {string} id                          stable id
 * @property {string} name                        human-readable label
 * @property {string} description                 1-2 sentence plain-English
 * @property {string} endpoint                    server route or "internal"
 * @property {string} file                        source file
 * @property {string} [lineRange]                 approximate line range
 * @property {string[]} providers                 ["openai", "anthropic", ...]
 * @property {string[]} models                    list of model strings or families
 * @property {string[]} actionTypes               action_type values logged for this surface
 * @property {("low"|"medium"|"high"|"variable")} tier
 * @property {boolean} guestAccessible            reachable without auth
 * @property {boolean} metered                    is logAiUsage actually called
 * @property {string} [optimization]              suggestions for cutting spend
 * @property {string[]} [risks]                   double-spend / waste flags
 */

/** @type {AISurface[]} */
export const AI_SURFACES = [
  // ─── HIGH cost ──────────────────────────────────────────────────────────
  {
    id: "chat_stream",
    name: "Authenticated chat (streaming)",
    description:
      "The main streaming chat for logged-in users. Big system prompt, optional vision (image inputs), optional retrieval/embedding side calls. Output tokens scale with response length.",
    endpoint: "POST /api/ai/stream",
    file: "server.js",
    lineRange: "~6534-7200",
    providers: ["openai", "anthropic", "google", "xai"],
    models: ["gpt-*", "claude-*", "gemini-*", "grok-*", "o3", "o4-mini"],
    actionTypes: [
      "chat_short",
      "chat_long",
      "chat_complex",
      "image_analysis",
      "board_analysis_light",
      "board_analysis_deep",
      "file_small",
      "file_large",
    ],
    tier: "high",
    guestAccessible: false,
    metered: true,
    optimization:
      "Cap max_completion_tokens (currently up to 4096), aggressively truncate history before sending, downgrade unified-auto default to a flash-tier model, prompt-cache the static system prompt where the provider supports it.",
    risks: [
      "Vision images count as ~1.5k–4k tokens each — expensive on every turn the image is in context.",
      "Synthesis retrieval fires an embedding call per full-enrichment turn.",
    ],
  },
  {
    id: "chat_invoke",
    name: "Authenticated chat (non-stream / actions)",
    description:
      "Non-streaming completion for one-shot results and structured JSON 'grid actions'. Same provider matrix as streaming chat.",
    endpoint: "POST /api/ai/invoke",
    file: "server.js",
    lineRange: "~4907-6532",
    providers: ["openai", "anthropic", "google", "xai"],
    models: ["gpt-*", "claude-*", "gemini-*", "grok-*"],
    actionTypes: [
      "chat_short",
      "chat_long",
      "chat_complex",
      "image_analysis",
      "board_analysis_light",
      "board_analysis_deep",
      "file_small",
      "file_large",
    ],
    tier: "high",
    guestAccessible: false,
    metered: true,
    optimization:
      "JSON-action paths can ask for max_tokens=8192 on Claude/Grok — clamp to what the schema actually needs. Skip Responses-API attempt on models that we know don't support it (avoid the duplicate Chat fallback in invokeOpenAIModel).",
    risks: [
      "invokeOpenAIModel may double-call OpenAI: tries /v1/responses then falls back to /v1/chat/completions.",
      "Gemini retry-on-429 runs a second full generation.",
    ],
  },
  {
    id: "browser_agent",
    name: "Agent Harness (browser + Bot stages)",
    description:
      "Stage-level structured model calls behind the desktop Agent Harness: task planning, per-round action decisions, action verification, post-task learning, and the small pre-turn route/offer judgements. The Bot Harness shares the decide/verify stages. Grounding (described target to screen point) is metered separately as browser_agent_ground.",
    endpoint: "POST /api/desktop/agent-model, POST /api/desktop/agent-ground",
    file: "server/routes/desktop.routes.js",
    lineRange: "~695-800",
    providers: ["openai", "anthropic", "holo"],
    models: [
      "gpt-5.6-terra (BROWSER_AGENT_MODEL)",
      "claude-opus-5 (plan/judge overrides)",
      "gpt-4.1-mini (learn/route/offer)",
      "holo3-1-35b-a3b (ground)",
    ],
    actionTypes: [
      "browser_agent_plan",
      "browser_agent_decide",
      "browser_agent_verify",
      "browser_agent_learn",
      "browser_agent_route",
      "browser_agent_offer",
      "browser_agent_judge",
      "browser_agent_ground",
    ],
    tier: "high",
    guestAccessible: false,
    metered: true,
    optimization:
      "Decide dominates: one call per browser round with the observation in context. Capability-tiered prompt loading already trims read-only rounds; keep observations bounded and prompt-cache the per-stage system prefix (cacheKey is already per stage+user).",
    risks: [
      "A long browse (up to 48 rounds) multiplies decide+verify calls per task.",
      "Screenshot rounds add vision tokens on top of the structured observation.",
    ],
  },
  {
    id: "youtube_transcribe",
    name: "YouTube transcription (Whisper)",
    description:
      "Downloads a YouTube video's audio (yt-dlp / fallbacks) and transcribes it via Whisper when no captions are available or the user requested a re-transcribe. Cost scales with audio duration.",
    endpoint: "POST /api/youtube/transcript[-priority|-retranscribe-segment]",
    file: "youtubeQa.js + server.js",
    lineRange: "youtubeQa.js ~425-810; server.js ~7800-7950",
    providers: ["openai"],
    models: ["whisper-1"],
    actionTypes: ["youtube_transcribe"],
    tier: "high",
    guestAccessible: false,
    metered: true,
    optimization:
      "Prefer captions whenever quality threshold permits. Tighten shouldRetranscribe so segment loops don't fire for marginal confidence. Cache full-video transcripts aggressively (already partial). Consider self-hosted Whisper for long-form (already supported via WHISPER_HOSTED_URL) — the hosted path isn't billed.",
    risks: [
      "answerVideoQuestion can call retranscribeSegment in a loop over windows — multiple Whisper jobs per question.",
      "Self-hosted Whisper path is silently NOT logged.",
    ],
  },
  {
    id: "transcription_upload",
    name: "Audio file upload transcription",
    description:
      "User uploads a file in the vault / canvas; server runs Whisper and caches per-user content hash.",
    endpoint: "POST /api/whisper/transcribe",
    file: "server.js",
    lineRange: "~7957-8027",
    providers: ["openai"],
    models: ["whisper-1"],
    actionTypes: ["transcription"],
    tier: "high",
    guestAccessible: false,
    metered: true,
    optimization:
      "Already content-hash cached per user. For a flat-rate plan: hard cap per-file duration and per-day per-user minutes to stop a single power user blowing the unit economics.",
  },

  // ─── MEDIUM cost ────────────────────────────────────────────────────────
  {
    id: "describe_image",
    name: "Vault item describe (vision / text)",
    description:
      "Generates a short description for a vault item. Vision branch (gpt-4o-mini, low detail) for images; text branch (gpt-4.1-nano) for documents/links. Supabase-backed cache.",
    endpoint: "POST /api/ai/describe-image",
    file: "server.js",
    lineRange: "~7270-7368",
    providers: ["openai"],
    models: ["gpt-4o-mini", "gpt-4.1-nano"],
    actionTypes: ["image_analysis", "describe_text"],
    tier: "medium",
    guestAccessible: false,
    metered: true,
    optimization:
      "Detail is already 'low'. Cache hit-rate is the lever — make sure the cache key includes only what changes the description (raw image hash, not URL). Skip the vision call entirely for items that came with a user-provided caption.",
  },
  {
    id: "tts",
    name: "Text-to-speech",
    description: "Converts assistant responses into MP3 audio.",
    endpoint: "POST /api/ai/tts",
    file: "server.js",
    lineRange: "~7573-7615",
    providers: ["openai"],
    models: ["tts-1", "tts-1-hd"],
    actionTypes: ["tts"],
    tier: "medium",
    guestAccessible: false,
    metered: true,
    optimization:
      "Use tts-1 (not tts-1-hd) by default — half the cost. Cap input length (currently unbounded). Cache by sha256(text + voice + model) for repeat phrases.",
  },
  {
    id: "transcription_dictation",
    name: "Dictation / mic input",
    description:
      "Short audio clips from the chat composer's mic button — the user is dictating a message.",
    endpoint: "POST /api/ai/transcribe",
    file: "server.js",
    lineRange: "~7371-7437",
    providers: ["openai"],
    models: ["whisper-1"],
    actionTypes: ["transcription"],
    tier: "medium",
    guestAccessible: false,
    metered: true,
    optimization:
      "Most clips are < 30s. Reject anything > 2 minutes server-side (it's almost certainly a misuse). Consider a cheaper hosted Whisper endpoint for dictation specifically.",
  },
  {
    id: "vault_enrich",
    name: "Vault note enrichment",
    description:
      "On note save, compresses note body into a summary + signal tags, then re-embeds chunks for retrieval. LLM + N embedding calls.",
    endpoint: "POST /api/vault/enrich-note",
    file: "server.js",
    lineRange: "~4499-4622",
    providers: ["openai"],
    models: ["gpt-4.1-nano", "text-embedding-3-small"],
    actionTypes: ["vault_enrich", "embedding_reindex"],
    tier: "medium",
    guestAccessible: false,
    metered: true,
    optimization:
      "Already skips when content hash unchanged. Debounce client-side so rapid saves don't queue redundant enrichment. Embed only when summary actually changed.",
    risks: ["Always two metered actions per real change (LLM + embed batch)."],
  },
  // ─── LOW cost ───────────────────────────────────────────────────────────
  {
    id: "guest_chat",
    name: "Logged-out chat (landing page)",
    description:
      "Streaming chat available to unauthenticated visitors on the landing page. Currently chained through Google models only (Flash / Flash-Lite).",
    endpoint: "POST /api/ai/stream-guest",
    file: "server.js",
    lineRange: "~2136-2547",
    providers: ["google"],
    models: ["gemini-flash-latest", "gemini-3-flash-preview", "gemini-3.1-flash-lite"],
    actionTypes: ["guest_chat"],
    tier: "low",
    guestAccessible: true,
    metered: true,
    optimization:
      "First-turn Flash vs Flash-Lite split is already cost-aware. Aggressive per-IP rate limiting is the main lever. Keep GUEST_MODEL_CHAIN_* strictly single-provider so future fallback edits don't double-bill.",
    risks: [
      "Dead Anthropic/OpenAI fallback branches still exist in the route — if anyone re-enables them via the chain config, every guest turn could fan out across providers.",
    ],
  },
  {
    id: "embedding_retrieval",
    name: "Retrieval embeddings (per query)",
    description:
      "Embeds a single query string to look up relevant synthesis chunks for the chat context.",
    endpoint: "internal (openAiEmbedQueryText)",
    file: "server.js",
    lineRange: "~664-705",
    providers: ["openai"],
    models: ["text-embedding-3-small"],
    actionTypes: ["embedding_retrieval"],
    tier: "low",
    guestAccessible: false,
    metered: true,
    optimization:
      "Cache per-(user, query-hash) — repeated similar queries from the same user are common in the same session.",
  },
  {
    id: "embedding_reindex",
    name: "Bulk embeddings (reindex / backfill)",
    description:
      "Batch embeds many synthesis chunks. Triggered by note enrichment, /api/synthesis/reindex, and the admin /api/synthesis/backfill endpoint.",
    endpoint: "internal (openAiEmbedMany / replaceSynthesisChunks)",
    file: "server.js",
    lineRange: "~822-880, ~4730-4904",
    providers: ["openai"],
    models: ["text-embedding-3-small"],
    actionTypes: ["embedding_reindex"],
    tier: "low",
    guestAccessible: false,
    metered: true,
    optimization:
      "Per-call cost is tiny but bulk operations add up. Hash-skip chunks that haven't changed (currently re-embeds all chunks on any enrichment).",
  },
  {
    id: "vault_search",
    name: "Vault search",
    description:
      "Ranks vault items against a free-form search prompt using a tiny model.",
    endpoint: "POST /api/ai/vault-search",
    file: "server.js",
    lineRange: "~7202-7242",
    providers: ["openai"],
    models: ["gpt-4.1-nano"],
    actionTypes: ["vault_search"],
    tier: "low",
    guestAccessible: false,
    metered: true,
    optimization:
      "max_tokens is 4096 but real responses are < 500 tokens — cap it. Cache by sha256(prompt) per user.",
  },
  {
    id: "summarize_conversation",
    name: "Conversation summarization",
    description:
      "Compresses the older portion of a long conversation into 2-4 sentences so the live chat can drop those raw turns from the context window.",
    endpoint: "POST /api/ai/summarize-conversation",
    file: "server.js",
    lineRange: "~7443-7503",
    providers: ["openai"],
    models: ["gpt-4.1-nano"],
    actionTypes: ["summarize_conversation"],
    tier: "low",
    guestAccessible: false,
    metered: true,
    optimization:
      "This *saves* money — keeps streaming chat input small. Already cached by content hash.",
  },
  {
    id: "name_grid",
    name: "Auto-name grid / board",
    description: "Picks a 2-5 word title for a board from its content.",
    endpoint: "POST /api/ai/name-grid",
    file: "server.js",
    lineRange: "~7508-7568",
    providers: ["openai"],
    models: ["gpt-4.1-nano"],
    actionTypes: ["name_grid"],
    tier: "low",
    guestAccessible: false,
    metered: true,
    optimization: "Already cheapest model + cache. Negligible.",
  },
  {
    id: "name_chat",
    name: "Auto-name chat",
    description:
      "Picks a 2-5 word title for a chat from the first user message + assistant reply, then writes it through to lykn_chats.title server-side.",
    endpoint: "POST /api/ai/name-chat",
    file: "server.js",
    lineRange: "~10950-11073",
    providers: ["openai"],
    models: ["gpt-4.1-nano"],
    actionTypes: ["name_chat"],
    tier: "low",
    guestAccessible: false,
    metered: true,
    optimization:
      "Cheapest model + per-snippet content cache + per-user prompt cache key. Fires fire-and-forget after the first turn, gated on title still being 'New Chat'.",
  },
];

// Tiers in display order, with colors for the UI.
export const TIER_META = {
  high:     { label: "HIGH",     order: 0, badgeClass: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" },
  medium:   { label: "MEDIUM",   order: 1, badgeClass: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" },
  low:      { label: "LOW",      order: 2, badgeClass: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
  variable: { label: "VARIABLE", order: 3, badgeClass: "bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30" },
};

// Build a reverse index: action_type -> surface[] (a single action_type can
// belong to multiple surfaces, e.g. chat_short comes from both /stream and
// /invoke). The dashboard uses this for a "this action belongs to which
// surface(s)?" tooltip.
export function buildActionTypeIndex() {
  const idx = new Map();
  for (const s of AI_SURFACES) {
    for (const a of s.actionTypes) {
      const list = idx.get(a) || [];
      list.push(s);
      idx.set(a, list);
    }
  }
  return idx;
}

// Given the by_action array returned by /api/admin/usage/overview, attach
// live spend totals to each surface. If two surfaces share an action_type
// (e.g. chat_short from both /stream and /invoke), the live spend is split
// proportionally to a heuristic weight — for now we just attribute the same
// number to both and flag it as "shared". A future improvement is to add a
// `surface_id` column to ai_usage_logs and query directly by surface.
//
// Returns a new array of surfaces enriched with:
//   { liveCost, liveRequests, liveTokens, sharedActionTypes }
export function attachLiveSpend(surfaces, byAction) {
  const totals = new Map();
  for (const row of byAction || []) {
    const at = String(row?.action_type || "");
    if (!at) continue;
    totals.set(at, {
      // RPC shape (admin_usage_overview): { action_type, calls, tokens, cost_usd, credits }
      cost: Number(row.cost_usd || row.total_cost_usd || 0) || 0,
      requests: Number(row.calls || row.request_count || 0) || 0,
      tokens: Number(row.tokens || row.total_tokens || 0) || 0,
    });
  }

  // Count how many surfaces claim each action_type so we can flag shared
  // ones. For shared types, attribute the FULL number to each (overcounting)
  // and mark the surface as `shared` so the UI shows a small warning. This
  // is intentionally pessimistic — better to surface "this number includes
  // overlap" than silently divide.
  const claimsCount = new Map();
  for (const s of surfaces) {
    for (const a of s.actionTypes) {
      claimsCount.set(a, (claimsCount.get(a) || 0) + 1);
    }
  }

  return surfaces.map((s) => {
    let cost = 0, requests = 0, tokens = 0;
    const shared = [];
    for (const a of s.actionTypes) {
      const t = totals.get(a);
      if (!t) continue;
      cost += t.cost;
      requests += t.requests;
      tokens += t.tokens;
      if ((claimsCount.get(a) || 0) > 1) shared.push(a);
    }
    return {
      ...s,
      liveCost: cost,
      liveRequests: requests,
      liveTokens: tokens,
      sharedActionTypes: shared,
    };
  });
}

// Returns surfaces with NO live data — i.e. the catalog says they should be
// metered but the time range has zero rows for any of their action_types.
// Useful flag: "this code path exists in your repo but isn't producing logs."
export function findSilentSurfaces(enrichedSurfaces) {
  return enrichedSurfaces.filter((s) => s.metered && s.liveRequests === 0);
}
