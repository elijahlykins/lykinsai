// ============================================================================
// agent-design-service.js — conversational agent blueprint (split-screen builder)
// ============================================================================

import {
  AgentComposeError,
  BUILDER_INTEGRATION_CATALOG,
  loadConnectedProviders,
  loadContextSnippetForDesign,
  normalizeAgentSpec,
  finishAgentBuild,
  _llmComposeJsonForDesign,
} from './agent-compose-service.js';
import {
  normalizeAgentDefinition,
  definitionToAgentSpec,
} from './agent-definition.js';

/**
 * One turn of the Agent builder chat — clarifies intent and updates the blueprint.
 *
 * @param {object} supabaseAdmin
 * @param {string} userId
 * @param {{ messages: {role,content}[], definition?: object, model?: string }} opts
 */
export async function agentDesignChatTurn(supabaseAdmin, userId, { messages = [], definition = null, model }) {
  const history = (Array.isArray(messages) ? messages : [])
    .filter((m) => m?.role === 'user' || m?.role === 'assistant')
    .map((m) => ({
      role: m.role,
      content: String(m.content || '').trim().slice(0, 4000),
    }))
    .filter((m) => m.content)
    .slice(-24);

  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (!lastUser?.content || lastUser.content.length < 2) {
    throw new AgentComposeError('Send a message describing your agent');
  }

  const connected = await loadConnectedProviders(supabaseAdmin, userId);
  const contextSnippet = await loadContextSnippetForDesign(supabaseAdmin, userId);

  const connectedList = [...connected].join(', ') || 'none';
  const catalogLines = Object.values(BUILDER_INTEGRATION_CATALOG)
    .map((c) => `- ${c.id}: ${c.label} — ${c.hint}`)
    .join('\n');

  const currentDef = definition
    ? JSON.stringify(normalizeAgentDefinition(definition, connected), null, 2)
    : '(empty — first draft)';

  const sys = `You are the LYKN Agent builder assistant. The user describes an automation agent in plain language. You clarify triggers, tools, ordered steps, and branching conditions — then output a structured blueprint (NOT code).

You have access to the user's LYKN synthesis context. Proactively suggest tools they already connected (${connectedList}) or patterns from their beliefs/projects when relevant. Example: "Based on your past work this looks like a sales workflow — you already have Airtable connected; want me to use that base?"

Available external integrations:
${catalogLines}

LYKN-native tools (always available): lykn_searchVault, lykn_getBeliefs, lykn_getRules, lykn_pushProjectState

Output ONLY valid JSON:
{
  "assistant_message": "markdown ok, 2-6 sentences, conversational — ask ONE clarifying question when status is drafting, or confirm the draft when ready",
  "definition": {
    "name": "short title",
    "subtitle": "ToolA → ToolB → ToolC pipeline summary",
    "connected_tools": [{ "id": "gmail", "label": "Gmail", "required": true, "reason": "why" }],
    "triggers": [{ "description": "when this agent runs" }],
    "steps": [{ "order": 1, "title": "Step title", "description": "what happens" }],
    "conditions": [{ "description": "only if X", "step_order": 4 }],
    "status": "drafting" | "ready",
    "synthesis_hint": "optional one-line note tying to LYKN context"
  },
  "ready_to_deploy": boolean — true only when triggers, at least 2 steps, and tools are clear enough to run a test
}

Rules:
- Update the blueprint on every turn; merge user refinements into definition.
- Use status "drafting" until triggers and steps are concrete; then "ready".
- Mark connected_tools[].connected true only for: ${connectedList}
- For LinkedIn/Airtable without OAuth in catalog, still list them in connected_tools with connected false and note in assistant_message they need API keys or manual steps for v1.
- Do not output handler code or JavaScript.`;

  const userPayload = [
    'Conversation so far:',
    history.map((m) => `${m.role}: ${m.content}`).join('\n'),
    '',
    'Current blueprint JSON:',
    currentDef,
    '',
    contextSnippet
      ? `LYKN context (use for proactive suggestions):\n${contextSnippet}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const { raw, model: composeModel } = await _llmComposeJsonForDesign({
    model,
    system: sys,
    user: userPayload,
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
    throw new AgentComposeError('Could not parse design output', 'parse_failed');
  }

  const def = normalizeAgentDefinition(parsed.definition || {}, connected);
  if (parsed.definition?.status === 'ready' || parsed.ready_to_deploy) {
    def.status = 'ready';
  }

  const sourceDescription = history
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n')
    .slice(0, 4000);

  const draftSpec = definitionToAgentSpec(def, { sourceDescription });
  const spec = normalizeAgentSpec(
    {
      ...draftSpec,
      agent_definition: def,
      compose_model: composeModel,
    },
    { sourceDescription },
  );
  spec.agent_definition = def;

  const integrations = (spec.integrations_required || []).map((row) => ({
    ...row,
    connected: connected.has(row.provider || row.id),
  }));

  return {
    assistant_message: String(parsed.assistant_message || 'Updated your agent blueprint on the right.'),
    definition: def,
    spec,
    integrations_required: integrations,
    ready_to_deploy: Boolean(parsed.ready_to_deploy) || def.status === 'ready',
    compose_model: composeModel,
    context_snippet_chars: contextSnippet?.length || 0,
  };
}

/**
 * Save blueprint as a hosted custom agent (no codegen path).
 */
export async function deployAgentFromDefinition(supabaseAdmin, userId, { definition, sourceDescription = '' }) {
  const connected = await loadConnectedProviders(supabaseAdmin, userId);
  const def = normalizeAgentDefinition(definition, connected);
  const partial = definitionToAgentSpec(def, { sourceDescription });
  const spec = normalizeAgentSpec(
    { ...partial, agent_definition: def },
    { sourceDescription: sourceDescription || partial.source_description },
  );
  spec.agent_definition = def;
  return finishAgentBuild(supabaseAdmin, userId, { spec });
}
