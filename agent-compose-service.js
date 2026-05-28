// ============================================================================
// agent-compose-service.js — natural-language agent spec composer + hosted trial
// ============================================================================
// Prototype for the "Lovable for agents" flow: user describes what they want,
// we emit a structured agent_spec (stored in lykn_custom_agents.metadata),
// and optionally run a one-shot hosted trial via the in-app agent loop.
// ============================================================================

import {
  listActiveBeliefsForUser,
  listActiveRulesForUser,
  formatBeliefsAndRulesForPromptOutsideClient,
  loadActiveProjectContext,
  loadOtherProjectsForUser,
} from './beliefSystem.js';
import { logAiUsage, extractOpenAIUsage, estimateTokens } from './usageTracking.js';
import {
  prepareHandlerSource,
  validateHandlerSource,
  buildFallbackAgentHandler,
  runAgentHandlerSandboxWithFallback,
  runVaultTopicAgentRun,
} from './agent-sandbox-runner.js';
import { shouldUseVaultTopicExecutor } from './agent-vault-search.js';

const COMPOSE_TOOL_CATALOG = [
  'lykn_getBeliefs',
  'lykn_getRules',
  'lykn_getFacts',
  'lykn_listProjects',
  'lykn_getProjectState',
  'lykn_getProjectNeurons',
  'lykn_findConnections',
  'lykn_loadNeuron',
  'lykn_loadNeurons',
  'lykn_searchVault',
  'lykn_getRecentActivity',
  'lykn_pushProjectState',
  'lykn_setActiveProject',
  'lykn_updateProject',
  'lykn_addProjectNeurons',
  'lykn_removeProjectNeurons',
  'lykn_recordRuleApplication',
  'lykn_proposeBelief',
  'lykn_proposeFact',
  'lykn_createVaultNote',
  'lykn_saveLinkToVault',
];

function buildChatToolCtxFromAdmin(supabaseAdmin, userId) {
  return {
    supabaseAdmin,
    userId,
    mcpAuth: null,
    clientLabel: 'LYKN-AgentStudio/1.0',
    attribSurface: 'lykn-chat',
    tokenId: null,
  };
}

function providerForTrialModel(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return null;
  if (m.startsWith('gpt-') || m === 'o3' || m === 'o3-pro' || m === 'o4-mini') return 'openai';
  if (m.includes('claude')) return 'anthropic';
  if (m.includes('grok')) return 'grok';
  if (m.startsWith('gemini-') || m.includes('gemini')) return 'gemini';
  return null;
}

/** Placeholder webhook URL for hosted-runtime agents (dispatcher uses metadata.runtime). */
export const HOSTED_AGENT_ENDPOINT = 'https://lykn.hosted/agent/v1';

const FALLBACK_COMPOSE_MODEL = 'gpt-4.1-nano';

function resolveAnthropicModelId(model) {
  const value = String(model || '').trim();
  const aliasMap = {
    'claude-3-7-sonnet-latest': 'claude-sonnet-4-6',
    'claude-3-5-sonnet-latest': 'claude-sonnet-4-6',
    'claude-3-opus-20240229': 'claude-opus-4-7',
    'claude-opus-4-6': 'claude-opus-4-7',
    'claude-opus-4-6-code': 'claude-opus-4-7',
  };
  return aliasMap[value] || value;
}

/** Opus 4.7+ rejects temperature / top_p / top_k on the Messages API (HTTP 400). */
function anthropicOmitsSamplingParams(modelId) {
  const m = String(modelId || '').toLowerCase();
  return m.includes('claude-opus-4-7') || m.includes('opus-4-7');
}

async function readLlmHttpError(res) {
  try {
    const data = await res.json();
    const msg =
      data?.error?.message ||
      data?.error?.type ||
      data?.message ||
      (typeof data?.error === 'string' ? data.error : '');
    if (msg) return String(msg);
    return JSON.stringify(data).slice(0, 500);
  } catch {
    try {
      return (await res.text()).slice(0, 500);
    } catch {
      return res.statusText || 'request failed';
    }
  }
}

async function throwComposeHttpError(label, res) {
  const detail = await readLlmHttpError(res);
  throw new AgentComposeError(
    `${label} (HTTP ${res.status})${detail ? `: ${detail}` : ''}`,
    'llm_http',
  );
}

function resolveAgentModel(model) {
  const raw = String(model || '').trim() || FALLBACK_COMPOSE_MODEL;
  const provider = providerForTrialModel(raw);
  if (!provider) {
    return { provider: 'openai', model: FALLBACK_COMPOSE_MODEL };
  }
  if (provider === 'anthropic') {
    return { provider, model: resolveAnthropicModelId(raw) };
  }
  if (provider === 'gemini' && raw === 'gemini-3-pro-preview') {
    return { provider, model: 'gemini-3.1-pro-preview' };
  }
  return { provider, model: raw };
}

async function llmComposeJson({ model, system, user, userId }) {
  const { provider, model: resolved } = resolveAgentModel(model);

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new AgentComposeError('OpenAI not configured', 'no_llm');
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolved,
        temperature: 0.35,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        prompt_cache_key: `agent-compose:${userId}:${resolved}`,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      await throwComposeHttpError('Composer failed', res);
    }
    const data = await res.json();
    const usage = extractOpenAIUsage(data);
    logAiUsage({
      userId,
      actionType: 'agent_compose',
      model: resolved,
      provider: 'openai',
      inputTokens: usage.input_tokens || estimateTokens(`${system}\n${user}`),
      outputTokens: usage.output_tokens || 0,
      metadata: { surface: 'agent_studio' },
    }).catch(() => {});
    return { raw: data?.choices?.[0]?.message?.content, model: resolved, provider };
  }

  if (provider === 'anthropic') {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new AgentComposeError('Anthropic not configured', 'no_llm');
    }
    const anthropicBody = {
      model: resolved,
      max_tokens: 1800,
      system: `${system}\n\nRespond with ONLY valid JSON, no markdown fences.`,
      messages: [{ role: 'user', content: user }],
    };
    if (!anthropicOmitsSamplingParams(resolved)) {
      anthropicBody.temperature = 0.35;
    }
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(anthropicBody),
    });
    if (!res.ok) {
      await throwComposeHttpError('Composer failed', res);
    }
    const data = await res.json();
    const text =
      (data.content || []).find((b) => b.type === 'text')?.text || '';
    logAiUsage({
      userId,
      actionType: 'agent_compose',
      model: resolved,
      provider: 'anthropic',
      inputTokens: estimateTokens(`${system}\n${user}`),
      outputTokens: estimateTokens(text),
      metadata: { surface: 'agent_studio' },
    }).catch(() => {});
    return { raw: text, model: resolved, provider };
  }

  if (provider === 'grok') {
    if (!process.env.XAI_API_KEY) {
      throw new AgentComposeError('xAI not configured', 'no_llm');
    }
    const res = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolved,
        temperature: 0.35,
        max_tokens: 1800,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      await throwComposeHttpError('Composer failed', res);
    }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    logAiUsage({
      userId,
      actionType: 'agent_compose',
      model: resolved,
      provider: 'grok',
      inputTokens: estimateTokens(`${system}\n${user}`),
      outputTokens: estimateTokens(String(raw || '')),
      metadata: { surface: 'agent_studio' },
    }).catch(() => {});
    return { raw, model: resolved, provider };
  }

  if (provider === 'gemini') {
    if (!process.env.GOOGLE_API_KEY) {
      throw new AgentComposeError('Gemini not configured', 'no_llm');
    }
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(resolved)}:generateContent?key=${process.env.GOOGLE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${system}\n\n${user}\n\nJSON only:` }] }],
          generationConfig: { temperature: 0.35, maxOutputTokens: 1800 },
        }),
      },
    );
    if (!res.ok) {
      await throwComposeHttpError('Composer failed', res);
    }
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    logAiUsage({
      userId,
      actionType: 'agent_compose',
      model: resolved,
      provider: 'gemini',
      inputTokens: estimateTokens(`${system}\n${user}`),
      outputTokens: estimateTokens(raw),
      metadata: { surface: 'agent_studio' },
    }).catch(() => {});
    return { raw, model: resolved, provider };
  }

  throw new AgentComposeError(`Unsupported model: ${model}`, 'no_provider');
}

export const AGENT_COMPOSE_TOOL_ALLOWLIST = new Set([
  'lykn_getBeliefs',
  'lykn_getRules',
  'lykn_getFacts',
  'lykn_listProjects',
  'lykn_getProjectState',
  'lykn_getProjectNeurons',
  'lykn_findConnections',
  'lykn_loadNeuron',
  'lykn_loadNeurons',
  'lykn_searchVault',
  'lykn_getRecentActivity',
  'lykn_pushProjectState',
  'lykn_setActiveProject',
  'lykn_updateProject',
  'lykn_addProjectNeurons',
  'lykn_removeProjectNeurons',
  'lykn_recordRuleApplication',
  'lykn_proposeBelief',
  'lykn_proposeFact',
  'lykn_createVaultNote',
  'lykn_saveLinkToVault',
]);

const ALLOWED_TRIGGERS = ['manual', 'chat', 'belief_ratified', 'project_state_push', 'scheduled'];
const ALLOWED_CONTEXT_MODES = ['full', 'project', 'minimal', 'none'];

class AgentComposeError extends Error {
  constructor(message, code = 'validation') {
    super(message);
    this.name = 'AgentComposeError';
    this.code = code;
  }
}

function sanitizeToolList(raw) {
  if (!Array.isArray(raw)) return ['lykn_searchVault', 'lykn_pushProjectState'];
  const cleaned = raw
    .map((t) => String(t || '').trim())
    .filter((t) => AGENT_COMPOSE_TOOL_ALLOWLIST.has(t));
  const uniq = [...new Set(cleaned)];
  return uniq.length ? uniq.slice(0, 12) : ['lykn_searchVault', 'lykn_pushProjectState'];
}

function sanitizeTriggers(raw) {
  if (!Array.isArray(raw)) return ['manual'];
  const cleaned = raw
    .map((t) => String(t || '').trim())
    .filter((t) => ALLOWED_TRIGGERS.includes(t));
  return cleaned.length ? [...new Set(cleaned)] : ['manual'];
}

function sanitizeContextMode(raw) {
  const m = String(raw || 'full').trim();
  return ALLOWED_CONTEXT_MODES.includes(m) ? m : 'full';
}

/**
 * Normalize LLM output into a stable agent_spec object.
 */
export function normalizeAgentSpec(raw = {}, { sourceDescription = '' } = {}) {
  const name = String(raw.name || 'Custom agent')
    .trim()
    .slice(0, 80);
  const description = String(raw.description || sourceDescription || '')
    .trim()
    .slice(0, 500);
  const instructions = String(raw.instructions || raw.system_prompt || '')
    .trim()
    .slice(0, 6000);
  if (!instructions) {
    throw new AgentComposeError('Agent instructions are required');
  }
  const sourceDesc = String(
    raw.source_description || sourceDescription || description || '',
  ).slice(0, 4000);
  const agentName = name || 'Custom agent';
  const spec = {
    version: 1,
    runtime: 'hosted',
    name: agentName,
    description,
    instructions,
    tools: sanitizeToolList(raw.tools),
    triggers: sanitizeTriggers(raw.triggers),
    context_mode: sanitizeContextMode(raw.context_mode),
    composed_at: raw.composed_at || new Date().toISOString(),
    source_description: sourceDesc,
    integrations_required: sanitizeIntegrations(raw.integrations_required, sourceDesc),
    welcome_message:
      String(raw.welcome_message || '').trim().slice(0, 800) ||
      `Built **${agentName}** — send a message below to run it.`,
  };
  if (raw.compose_model) spec.compose_model = String(raw.compose_model).trim();
  if (raw.implementation?.files?.length) spec.implementation = raw.implementation;
  return spec;
}

async function loadContextSnippet(ctx, maxChars = 1600) {
  if (!ctx?.supabaseAdmin || !ctx?.userId) return '';
  try {
    const cap = Math.max(200, Math.min(8000, maxChars));
    const [beliefs, rules, projectContext] = await Promise.all([
      listActiveBeliefsForUser(ctx.supabaseAdmin, ctx.userId),
      listActiveRulesForUser(ctx.supabaseAdmin, ctx.userId),
      loadActiveProjectContext(ctx.supabaseAdmin, ctx.userId),
    ]);
    const otherProjects = await loadOtherProjectsForUser(ctx.supabaseAdmin, ctx.userId, {
      excludeId: projectContext?.project?.id || null,
      limit: 5,
    });
    if (!beliefs.length && !projectContext && otherProjects.length === 0) {
      return '';
    }
    return (
      formatBeliefsAndRulesForPromptOutsideClient(beliefs, rules, {
        maxChars: cap,
        projectContext,
        otherProjects,
      }) || ''
    );
  } catch {
    return '';
  }
}

/**
 * Turn a natural-language brief into a draft agent_spec (JSON).
 */
export async function composeAgentSpecFromDescription(
  supabaseAdmin,
  userId,
  { description, req, model },
) {
  const brief = String(description || '').trim();
  if (brief.length < 12) {
    throw new AgentComposeError('Describe what you want the agent to do (at least 12 characters)');
  }
  if (brief.length > 4000) {
    throw new AgentComposeError('Description is too long (max 4000 characters)');
  }
  const ctx = buildChatToolCtxFromAdmin(supabaseAdmin, userId);
  const contextSnippet = await loadContextSnippet(ctx);

  const toolCatalog = COMPOSE_TOOL_CATALOG.filter((n) => AGENT_COMPOSE_TOOL_ALLOWLIST.has(n)).join(', ');

  const sys = `You design LYKN custom agents — assistants that run with the user's synthesis layer (beliefs, rules, projects, vault).

Output ONLY valid JSON with:
- name: string, 3-60 chars, user-facing title
- description: string, max 200 chars, what the agent does
- instructions: string, max 2500 chars, system-prompt style directions for the hosted agent. Must tell it to honor [LYKN_CONTEXT] beliefs/rules, use only allowed tools, and call lykn_pushProjectState when it makes durable project decisions.
- tools: array of 2-8 tool names chosen ONLY from this allowlist: ${toolCatalog}
- triggers: array from ["manual","chat","project_state_push"] — prefer manual for v1 prototypes unless the user explicitly asked for chat or project hooks
- context_mode: one of "full"|"project"|"minimal" — default "full" unless user wants a lighter agent
- integrations_required: array of 0-3 objects { "id": "gmail"|"google-calendar"|"google-drive"|"slack"|"notion", "reason": "why this agent needs it" }. Include gmail if the user wants to send/read email; google-calendar for scheduling; slack for Slack messages; notion for Notion pages; google-drive for Drive files. Omit if only LYKN vault/synthesis tools are enough.
- welcome_message: string, max 400 chars, first-person summary of what you built (markdown ok). Tell the user to press **Run agent** in the workspace. Do NOT say "say the word", "hit go", "whenever you want", or defer work. Do NOT claim you already searched the vault or ran tools.

Vault search guidance: when the brief is about UI/UX/design (not email), instructions MUST tell the agent to search with specific design terms (e.g. "UI design", "design system", "figma", "wireframe") and to SKIP or exclude vault items tagged gmail/email/inbox or that look like email threads. Do NOT use lykn_getRecentActivity as a primary source for design/UI agents — recency favors synced email. Only include gmail in integrations_required when the user explicitly wants email.

Ground the agent in the user's brief and their LYKN context snippet when relevant. Do not invent biographical facts not in the snippet.`;

  const userMsg = [
    'User brief:',
    brief,
    '',
    contextSnippet
      ? `LYKN context snippet (for grounding only):\n${contextSnippet}`
      : '(No LYKN context yet — design a general-purpose agent from the brief.)',
  ].join('\n');

  const { raw, model: composeModel } = await llmComposeJson({
    model,
    system: sys,
    user: userMsg,
    userId,
  });

  let parsed;
  try {
    const text = String(raw || '').trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    const slice =
      jsonStart >= 0 && jsonEnd > jsonStart ? text.slice(jsonStart, jsonEnd + 1) : text;
    parsed = JSON.parse(slice || '{}');
  } catch {
    throw new AgentComposeError('Could not parse composer output', 'parse_failed');
  }

  const spec = normalizeAgentSpec(parsed, { sourceDescription: brief });
  spec.compose_model = composeModel;
  return { spec, context_snippet_chars: contextSnippet.length };
}

/** Known external connectors the builder can gate on before finishing. */
export const BUILDER_INTEGRATION_CATALOG = {
  gmail: {
    id: 'gmail',
    label: 'Gmail',
    provider: 'gmail',
    domain: 'mail.google.com',
    hint: 'Read starred mail and send email on your behalf',
  },
  'google-calendar': {
    id: 'google-calendar',
    label: 'Google Calendar',
    provider: 'google-calendar',
    domain: 'calendar.google.com',
    hint: 'See upcoming events and schedule on your calendar',
  },
  'google-drive': {
    id: 'google-drive',
    label: 'Google Drive',
    provider: 'google-drive',
    domain: 'drive.google.com',
    hint: 'Access files you store in Drive',
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    provider: 'slack',
    domain: 'slack.com',
    hint: 'Post messages and read channels you connect',
  },
  notion: {
    id: 'notion',
    label: 'Notion',
    provider: 'notion',
    domain: 'notion.so',
    hint: 'Read and update Notion pages',
  },
};

const INTEGRATION_KEYWORDS = [
  { id: 'gmail', re: /\b(email|e-mail|gmail|inbox|send\s+(?:an?\s+)?mail|draft\s+mail)\b/i },
  { id: 'google-calendar', re: /\b(calendar|schedule\s+meeting|google\s+calendar)\b/i },
  { id: 'google-drive', re: /\b(google\s+drive|gdrive|drive\s+files)\b/i },
  { id: 'slack', re: /\b(slack|#\w+ channel)\b/i },
  { id: 'notion', re: /\b(notion)\b/i },
];

function sanitizeIntegrations(raw, brief = '') {
  const out = [];
  const seen = new Set();
  const add = (id, reason = '') => {
    const meta = BUILDER_INTEGRATION_CATALOG[id];
    if (!meta || seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      label: meta.label,
      provider: meta.provider,
      reason: String(reason || meta.hint).slice(0, 240),
    });
  };
  if (Array.isArray(raw)) {
    for (const row of raw) {
      const id = String(row?.id || row?.provider || '').trim();
      if (!id) continue;
      add(id, row?.reason || row?.hint);
    }
  }
  for (const { id, re } of INTEGRATION_KEYWORDS) {
    if (re.test(brief)) add(id);
  }
  return out.slice(0, 4);
}

async function loadConnectedProviders(supabaseAdmin, userId) {
  if (!supabaseAdmin || !userId) return new Set();
  const { data } = await supabaseAdmin
    .from('social_connections')
    .select('provider, status')
    .eq('user_id', userId);
  const connected = new Set();
  for (const row of data || []) {
    if (row?.status === 'active' || row?.status === 'paused') {
      connected.add(String(row.provider || ''));
    }
  }
  return connected;
}

function buildImplementationPreview(spec, integrations, implementation = null) {
  const lines = integrations.length
    ? integrations.map((i) => `• Wire **${i.label}** — ${i.reason}`)
    : ['• No external accounts required — LYKN synthesis tools only'];
  const fileCount = implementation?.files?.length || 0;
  const sandboxSteps = [
    'Load beliefs, rules, and active project from synthesis',
    'Compile agent instructions + tool allowlist',
    ...integrations.map((i) => `Attach ${i.label} OAuth capability`),
    fileCount
      ? `Write ${fileCount} implementation file${fileCount === 1 ? '' : 's'} in sandbox`
      : 'Generate hosted handler in sandbox',
    'Register runtime on LYKN',
    'Run smoke test in sandbox',
  ];
  return {
    summary: implementation?.summary || spec.description || spec.source_description || '',
    capabilities: lines,
    sandbox_steps: sandboxSteps,
    runtime: 'hosted',
    implementation,
    note: fileCount
      ? 'Agent code is saved with your agent and powers the hosted trial below.'
      : 'Agent runs on LYKN with your live context and connected accounts.',
  };
}

/**
 * Stream plain-text completion tokens (OpenAI-compatible SSE).
 */
async function streamLlmText({ model, system, user, userId, onDelta, maxTokens = 4096 }) {
  const { provider, model: resolved } = resolveAgentModel(model);
  const emit = (text) => {
    if (text) onDelta(text);
  };

  if (provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) {
      throw new AgentComposeError('OpenAI not configured', 'no_llm');
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolved,
        temperature: 0.25,
        max_tokens: maxTokens,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      await throwComposeHttpError('Code generation failed', res);
    }
    const reader = res.body?.getReader?.();
    if (!reader) {
      throw new AgentComposeError('Streaming not available', 'llm_http');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const piece = parsed?.choices?.[0]?.delta?.content || '';
          if (piece) {
            full += piece;
            emit(piece);
          }
        } catch {
          // ignore partial SSE frames
        }
      }
    }
    logAiUsage({
      userId,
      actionType: 'agent_code_gen',
      model: resolved,
      provider: 'openai',
      inputTokens: estimateTokens(`${system}\n${user}`),
      outputTokens: estimateTokens(full),
      metadata: { surface: 'agent_studio' },
    }).catch(() => {});
    return { full, model: resolved, provider };
  }

  // Non-streaming fallback for Anthropic / Grok / Gemini
  const { raw, model: resolvedModel, provider: resolvedProvider } = await llmComposeJson({
    model,
    system: `${system}\n\nOutput ONLY the source code. No markdown fences.`,
    user,
    userId,
  });
  const full = String(raw || '').trim();
  emit(full);
  return { full, model: resolvedModel, provider: resolvedProvider };
}

/**
 * Generate runnable agent handler source (streamed to UI).
 */
export async function generateAgentImplementationCode(
  { spec, description, model, userId },
  onDelta,
) {
  const toolList = (spec.tools || []).join(', ');
  const integrationList = (spec.integrations_required || [])
    .map((i) => i.id || i.provider)
    .filter(Boolean)
    .join(', ') || 'none';

  const system = `You are a senior engineer implementing a LYKN hosted agent.

Write a single ES module file \`agent/handler.mjs\` that exports:

export async function runAgent({ message, tools, context }) {
  // message: string user input
  // tools: async (name, args) => result — only call tools from the allowlist
  // context: { beliefs, project, synthesis } strings
  return { reply: string, toolCalls?: array };
}

Requirements:
- Implement the agent behavior from the brief using ONLY these LYKN tools: ${toolList}
- Honor integrations: ${integrationList} (use tools / comments for OAuth-gated flows)
- Call lykn_pushProjectState when making durable project updates
- Call lykn_recordRuleApplication when applying a rule (pass rule_id)
- Robust try/catch; never throw to caller — return { reply: error message }
- When runAgent is called, execute the user's request immediately (search vault, etc.) — do not reply with only "ready to start" without calling tools
- For UI/UX/design tasks: run multiple lykn_searchVault queries with specific design keywords (UI design, design system, figma, wireframe, typography, mockup) — NOT the user's full sentence tokenized. Filter OUT hits whose tags include gmail, email, or inbox, and hits that look like email (Re:, Fwd:, unsubscribe). Do not rely on lykn_getRecentActivity for design pulls.
- No external npm imports; Node 18+ ESM
- Keep handler under ~180 lines — must return { reply: string } with real vault results, never "ready to start"
- searchVault returns { hits: [...] } — use hit.node_id for lykn_loadNeurons({ node_ids: [...] })
- Output ONLY raw JavaScript source code for agent/handler.mjs — no markdown fences, no JSON wrapper`;

  const user = [
    'Agent name:',
    spec.name,
    '',
    'Agent instructions:',
    spec.instructions,
    '',
    'Original user brief:',
    description,
  ].join('\n');

  const { full } = await streamLlmText({
    model,
    system,
    user,
    userId,
    onDelta,
    maxTokens: 8192,
  });

  let cleaned = String(full || '')
    .replace(/^```(?:javascript|js|mjs)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const prepared = prepareHandlerSource(cleaned);
  const syntax = validateHandlerSource(prepared);
  if (!syntax.ok) {
    console.warn('[agent-studio] generated handler invalid, using vault executor template:', syntax.error);
    cleaned = buildFallbackAgentHandler(spec);
  }

  const config = {
    version: 1,
    name: spec.name,
    tools: spec.tools,
    triggers: spec.triggers,
    context_mode: spec.context_mode,
    integrations: (spec.integrations_required || []).map((i) => i.id || i.provider),
  };

  const files = [
    {
      path: 'agent/handler.mjs',
      language: 'javascript',
      content: cleaned || '// handler generation failed — using hosted LYKN runtime only\nexport async function runAgent({ message }) {\n  return { reply: "Agent handler missing — trial uses LYKN hosted runtime." };\n}',
    },
    {
      path: 'agent/config.json',
      language: 'json',
      content: JSON.stringify(config, null, 2),
    },
  ];

  return {
    entrypoint: 'agent/handler.mjs',
    files,
    summary: `Implemented ${spec.name} with ${files.length} files and ${spec.tools?.length || 0} LYKN tools.`,
    generated_at: new Date().toISOString(),
    compose_model: model,
  };
}

function emitEvent(onEvent, payload) {
  if (typeof onEvent === 'function') {
    onEvent(payload);
  }
}

/**
 * Streaming builder — emits log / code_delta / code_file / done events.
 */
export async function buildAgentFromDescriptionStream(
  supabaseAdmin,
  userId,
  { description, req, autoSave = true, model },
  onEvent,
) {
  const buildLog = [];
  const pushLog = (message, status = 'done') => {
    const row = { message, status, at: new Date().toISOString() };
    buildLog.push(row);
    emitEvent(onEvent, { type: 'log', ...row });
  };

  pushLog('Reading your synthesis layer…', 'running');
  const { spec, context_snippet_chars } = await composeAgentSpecFromDescription(
    supabaseAdmin,
    userId,
    { description, req, model },
  );
  buildLog[buildLog.length - 1].status = 'done';
  emitEvent(onEvent, { type: 'log', ...buildLog[buildLog.length - 1] });
  pushLog(
    context_snippet_chars
      ? 'Context loaded — beliefs, project, and vault tools available'
      : 'No synthesis context yet — building from your description',
  );

  pushLog('Designing agent instructions and tool access…', 'running');
  buildLog[buildLog.length - 1].status = 'done';
  emitEvent(onEvent, { type: 'log', ...buildLog[buildLog.length - 1] });

  const connected = await loadConnectedProviders(supabaseAdmin, userId);
  const integrations = (spec.integrations_required || []).map((row) => ({
    ...row,
    connected: connected.has(row.provider),
  }));
  spec.integrations_required = integrations;

  const missing = integrations.filter((i) => !i.connected);
  if (missing.length) {
    for (const m of missing) {
      pushLog(`Needs permission: ${m.label}`, 'waiting');
    }
  } else if (integrations.length) {
    pushLog(`Connected accounts: ${integrations.map((i) => i.label).join(', ')}`);
  }

  pushLog('Writing agent implementation…', 'running');
  emitEvent(onEvent, { type: 'code_start', path: 'agent/handler.mjs' });

  const implementation = await generateAgentImplementationCode(
    { spec, description, model, userId },
    (text) => {
      emitEvent(onEvent, { type: 'code_delta', path: 'agent/handler.mjs', text });
    },
  );
  spec.implementation = implementation;

  for (const file of implementation.files || []) {
    emitEvent(onEvent, {
      type: 'code_file',
      path: file.path,
      language: file.language,
      content: file.content,
    });
  }

  buildLog[buildLog.length - 1].status = 'done';
  emitEvent(onEvent, { type: 'log', ...buildLog[buildLog.length - 1] });
  pushLog(`Wrote ${implementation.files?.length || 0} files — ${implementation.entrypoint}`);

  pushLog('Registering hosted runtime…', 'running');
  const implementation_preview = buildImplementationPreview(spec, integrations, implementation);
  buildLog[buildLog.length - 1].status = 'done';
  emitEvent(onEvent, { type: 'log', ...buildLog[buildLog.length - 1] });
  pushLog(`Agent ready: ${spec.name}`);

  const status = missing.length ? 'awaiting_permissions' : 'complete';
  let agent = null;
  if (status === 'complete' && autoSave) {
    const { createCustomAgent } = await import('./custom-agents-service.js');
    agent = await createCustomAgent(supabaseAdmin, userId, {
      name: spec.name,
      description: spec.description || spec.source_description || null,
      endpoint_url: HOSTED_AGENT_ENDPOINT,
      triggers: spec.triggers,
      context_mode: spec.context_mode,
      metadata: {
        runtime: 'hosted',
        agent_spec: spec,
        integrations_required: integrations,
        implementation_preview,
        implementation,
        built_at: new Date().toISOString(),
      },
    });
    pushLog('Saved to your agents');
  }

  const assistant_message =
    status === 'awaiting_permissions'
      ? `${spec.welcome_message}\n\nI wrote the agent code in the sandbox. Connect the accounts below to finish.`
      : `${spec.welcome_message}\n\nTap **Use agent** — then press **Run agent** in the workspace.`;

  const result = {
    status,
    spec,
    build_log: buildLog,
    integrations_required: integrations,
    implementation_preview,
    implementation,
    assistant_message,
    agent,
  };

  emitEvent(onEvent, { type: 'done', ...result });
  return result;
}

/**
 * End-to-end build: compose spec, check integrations, emit build log + preview.
 */
export async function buildAgentFromDescription(
  supabaseAdmin,
  userId,
  { description, req, autoSave = true, model },
) {
  const buildLog = [];
  const push = (message, status = 'done') => {
    buildLog.push({ message, status, at: new Date().toISOString() });
  };

  push('Reading your synthesis layer…', 'running');
  const { spec, context_snippet_chars } = await composeAgentSpecFromDescription(
    supabaseAdmin,
    userId,
    { description, req, model },
  );
  buildLog[buildLog.length - 1].status = 'done';
  push(
    context_snippet_chars
      ? 'Context loaded — beliefs, project, and vault tools available'
      : 'No synthesis context yet — agent will still build from your description',
  );

  push('Designing agent instructions and tool access…', 'running');
  buildLog[buildLog.length - 1].status = 'done';

  const connected = await loadConnectedProviders(supabaseAdmin, userId);
  const integrations = (spec.integrations_required || []).map((row) => ({
    ...row,
    connected: connected.has(row.provider),
  }));

  const missing = integrations.filter((i) => !i.connected);
  if (missing.length) {
    for (const m of missing) {
      push(`Needs permission: ${m.label}`, 'waiting');
    }
  } else if (integrations.length) {
    push(`Connected accounts: ${integrations.map((i) => i.label).join(', ')}`);
  }

  push('Writing agent implementation…', 'running');
  const implementation = await generateAgentImplementationCode(
    { spec, description, model, userId },
    () => {},
  );
  spec.implementation = implementation;
  buildLog[buildLog.length - 1].status = 'done';
  push(`Wrote ${implementation.files?.length || 0} files — ${implementation.entrypoint}`);

  push('Registering hosted runtime…', 'running');
  const implementation_preview = buildImplementationPreview(spec, integrations, implementation);
  buildLog[buildLog.length - 1].status = 'done';
  push(`Agent ready: ${spec.name}`);

  const status = missing.length ? 'awaiting_permissions' : 'complete';
  let agent = null;
  if (status === 'complete' && autoSave) {
    const { createCustomAgent } = await import('./custom-agents-service.js');
    agent = await createCustomAgent(supabaseAdmin, userId, {
      name: spec.name,
      description: spec.description || spec.source_description || null,
      endpoint_url: HOSTED_AGENT_ENDPOINT,
      triggers: spec.triggers,
      context_mode: spec.context_mode,
      metadata: {
        runtime: 'hosted',
        agent_spec: spec,
        integrations_required: integrations,
        implementation_preview,
        implementation,
        built_at: new Date().toISOString(),
      },
    });
    push('Saved to your agents', 'done');
  }

  const assistant_message =
    status === 'awaiting_permissions'
      ? `${spec.welcome_message}\n\nTo finish building, connect the accounts below — then I'll complete the agent in this window.`
      : `${spec.welcome_message}\n\nYour agent is live in this sandbox. Ask it to do something, or describe a change.`;

  return {
    status,
    spec,
    build_log: buildLog,
    integrations_required: integrations,
    implementation_preview,
    assistant_message,
    agent,
  };
}

function buildHostedSystemPrompt(spec, contextBlock) {
  const toolLine = spec.tools.length
    ? spec.tools.join(', ')
    : '(no tools — answer from context only)';
  return [
    'You are a LYKN-hosted custom agent. Follow the user\'s agent brief below.',
    '',
    '## Agent brief',
    spec.instructions,
    '',
    '## Tool policy',
    `You may call ONLY these LYKN tools: ${toolLine}.`,
    'Do not invent tool names. If a needed tool is missing, explain the limitation.',
    'On the first user message, execute their request with tools — do not only describe what you would do.',
    'Vault search: use short, specific lykn_searchVault queries. For UI/design work, exclude gmail/email/inbox-tagged hits unless the user asked for email. Prefer targeted design queries over lykn_getRecentActivity.',
    'When you follow a belief rule from context, call lykn_recordRuleApplication with the rule_id.',
    'When you make a durable project decision, call lykn_pushProjectState.',
    '',
    '## LYKN context (binding)',
    contextBlock || '(empty — user has little synthesis data yet)',
  ].join('\n');
}

/**
 * Run a one-shot hosted trial for a draft or saved agent_spec.
 */
export async function runHostedAgentTrial(
  supabaseAdmin,
  userId,
  { spec, testMessage, req, model },
) {
  const message = String(testMessage || '').trim();
  if (message.length < 2) {
    throw new AgentComposeError('Enter a test message for the agent');
  }
  if (message.length > 4000) {
    throw new AgentComposeError('Test message is too long');
  }

  const rawSpec = spec && typeof spec === 'object' ? spec : {};
  const normalized = normalizeAgentSpec(rawSpec);
  if (rawSpec.implementation && !normalized.implementation) {
    normalized.implementation = rawSpec.implementation;
  }
  let ctx = buildChatToolCtxFromAdmin(supabaseAdmin, userId);
  if (req?.user?.id && req?.app?.get) {
    const { buildChatToolCtx } = await import('./mcp-tools/chatTools.js');
    ctx = buildChatToolCtx(req);
  }
  let contextBlock = '';
  if (normalized.context_mode !== 'none') {
    const max =
      normalized.context_mode === 'minimal'
        ? 1200
        : normalized.context_mode === 'project'
          ? 2000
          : 3200;
    contextBlock = await loadContextSnippet(ctx, max);
  }

  if (shouldUseVaultTopicExecutor(normalized, message)) {
    try {
      const topicResult = await runVaultTopicAgentRun({
        spec: normalized,
        message,
        ctx,
        contextBlock,
      });
      logAiUsage({
        userId,
        actionType: 'agent_trial_vault_topic',
        model: 'vault-topic',
        provider: 'lykn',
        inputTokens: estimateTokens(message),
        outputTokens: estimateTokens(topicResult.reply),
        metadata: {
          tools: normalized.tools.length,
          tool_calls: topicResult.tool_calls?.length || 0,
          runtime: topicResult.runtime,
          queries: topicResult.meta?.queries?.length,
        },
      }).catch(() => {});
      return {
        ...topicResult,
        spec: normalized,
      };
    } catch (topicErr) {
      console.warn('[agent-studio] vault topic run failed, trying handler:', topicErr?.message || topicErr);
      normalized._last_topic_error = String(topicErr?.message || topicErr);
    }
  }

  const impl = normalized.implementation;
  const handlerFile = (impl?.files || []).find(
    (f) => f?.path === 'agent/handler.mjs' || String(f?.path || '').endsWith('handler.mjs'),
  );
  const handlerSource = String(handlerFile?.content || '').trim();

  if (handlerSource) {
    try {
      const handlerResult = await runAgentHandlerSandboxWithFallback({
        source: handlerSource,
        spec: normalized,
        message,
        ctx,
        contextBlock,
      });
      logAiUsage({
        userId,
        actionType: 'agent_trial_handler',
        model: 'sandbox-handler',
        provider: 'lykn',
        inputTokens: estimateTokens(message),
        outputTokens: estimateTokens(handlerResult.reply),
        metadata: {
          tools: normalized.tools.length,
          tool_calls: handlerResult.tool_calls?.length || 0,
          runtime: handlerResult.runtime,
        },
      }).catch(() => {});
      return {
        ...handlerResult,
        spec: normalized,
      };
    } catch (err) {
      console.warn('[agent-studio] sandbox handler failed, falling back to LLM:', err?.message || err);
      normalized._last_handler_error = String(err?.message || err);
    }
  }

  const systemPrompt = buildHostedSystemPrompt(normalized, contextBlock);
  const trialModel =
    String(model || normalized.compose_model || '').trim() || FALLBACK_COMPOSE_MODEL;
  const { provider, model: resolvedModel } = resolveAgentModel(trialModel);
  if (!provider) {
    throw new AgentComposeError('Trial model is not supported', 'no_provider');
  }

  const { runAgentLoop } = await import('./chat-agent-loop.js');

  const chunks = [];
  const toolCalls = [];

  const agentResult = await runAgentLoop({
    provider,
    model: resolvedModel,
    systemPrompt,
    userContent: message,
    priorTurns: [],
    maxOutputTokens: 4096,
    maxHops: 10,
    maxToolCallsPerHop: 16,
    promptCacheKey: `agent-trial:${userId}:${resolvedModel}`,
    env: process.env,
    ctx,
    onTextChunk: (t) => {
      if (t) chunks.push(t);
    },
    onToolCall: (evt) => {
      if (evt) toolCalls.push(evt);
    },
  });

  const reply = chunks.join('').trim();

  logAiUsage({
    userId,
    actionType: 'agent_trial',
    model: resolvedModel,
    provider,
    inputTokens: estimateTokens(`${systemPrompt}\n${message}`),
    outputTokens: estimateTokens(reply),
    metadata: {
      tools: normalized.tools.length,
      hops: toolCalls.length,
      ok: agentResult.ok,
    },
  }).catch(() => {});

  let finalReply = reply || (agentResult.hadText ? '' : 'No reply text — try a clearer test message.');
  if (normalized._last_handler_error) {
    finalReply = `**Sandbox note:** Generated handler could not run (${normalized._last_handler_error}).\n\n${finalReply}`;
  }

  return {
    ok: agentResult.ok,
    reply: finalReply,
    tool_calls: toolCalls.slice(-24),
    reason: agentResult.reason,
    error_message: agentResult.errorMessage || null,
    runtime: 'llm',
    spec: normalized,
  };
}

/**
 * After OAuth: verify integrations and save the draft spec without re-composing.
 */
export async function finishAgentBuild(supabaseAdmin, userId, { spec }) {
  const normalized = normalizeAgentSpec(spec || {});
  const integrations = sanitizeIntegrations(
    normalized.integrations_required,
    normalized.source_description || '',
  ).map((row) => ({ ...row, connected: false }));

  const connected = await loadConnectedProviders(supabaseAdmin, userId);
  for (const row of integrations) {
    row.connected = connected.has(row.provider);
  }
  normalized.integrations_required = integrations;

  const missing = integrations.filter((i) => !i.connected);
  if (missing.length) {
    return {
      status: 'awaiting_permissions',
      spec: normalized,
      integrations_required: integrations,
      assistant_message:
        'Still waiting on: ' +
        missing.map((m) => m.label).join(', ') +
        '. Connect below, then tap Continue.',
    };
  }

  const implementation_preview = buildImplementationPreview(normalized, integrations);
  const { createCustomAgent } = await import('./custom-agents-service.js');
  const agent = await createCustomAgent(supabaseAdmin, userId, {
    name: normalized.name,
    description: normalized.description || normalized.source_description || null,
    endpoint_url: HOSTED_AGENT_ENDPOINT,
    triggers: normalized.triggers,
    context_mode: normalized.context_mode,
    metadata: {
      runtime: 'hosted',
      agent_spec: normalized,
      integrations_required: integrations,
      implementation_preview,
      built_at: new Date().toISOString(),
    },
  });

  return {
    status: 'complete',
    spec: normalized,
    integrations_required: integrations,
    implementation_preview,
    agent,
    assistant_message:
      `${normalized.welcome_message || `**${normalized.name}** is ready.`}\n\nYour agent is live in this sandbox — try giving it a task.`,
  };
}

export { AgentComposeError, loadConnectedProviders };
