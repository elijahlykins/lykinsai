// ============================================================================
// agent-definition.js — structured agent blueprint (triggers, steps, tools)
// ============================================================================

const KNOWN_TOOL_IDS = new Set([
  'gmail',
  'google-calendar',
  'google-drive',
  'slack',
  'notion',
  'linkedin',
  'airtable',
  'lykn_searchVault',
  'lykn_getBeliefs',
  'lykn_getRules',
  'lykn_pushProjectState',
]);

const BUILDER_INTEGRATION_IDS = new Set([
  'gmail',
  'google-calendar',
  'google-drive',
  'slack',
  'notion',
]);

const TOOL_LABELS = {
  gmail: 'Gmail',
  'google-calendar': 'Google Calendar',
  'google-drive': 'Google Drive',
  slack: 'Slack',
  notion: 'Notion',
  linkedin: 'LinkedIn',
  airtable: 'Airtable',
  lykn_searchVault: 'LYKN Vault',
};

/**
 * @param {object} raw
 * @param {Set<string>} [connectedProviders]
 */
export function normalizeAgentDefinition(raw = {}, connectedProviders = new Set()) {
  const name = String(raw.name || 'Untitled agent').trim().slice(0, 80);
  const subtitle = String(raw.subtitle || raw.pipeline || '').trim().slice(0, 120);

  const connected_tools = (Array.isArray(raw.connected_tools) ? raw.connected_tools : [])
    .map((t) => {
      const id = String(t?.id || t?.provider || '').trim().toLowerCase();
      if (!id) return null;
      return {
        id,
        label: String(t?.label || TOOL_LABELS[id] || id).slice(0, 40),
        required: t?.required !== false,
        connected:
          typeof t?.connected === 'boolean'
            ? t.connected
            : connectedProviders.has(id),
        reason: String(t?.reason || '').slice(0, 200),
      };
    })
    .filter(Boolean)
    .slice(0, 12);

  const triggers = (Array.isArray(raw.triggers) ? raw.triggers : [])
    .map((t, i) => ({
      id: String(t?.id || `trigger-${i + 1}`),
      description: String(t?.description || t?.text || '').trim().slice(0, 400),
    }))
    .filter((t) => t.description)
    .slice(0, 8);

  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map((s, i) => ({
      order: Number.isFinite(s?.order) ? s.order : i + 1,
      title: String(s?.title || `Step ${i + 1}`).trim().slice(0, 80),
      description: String(s?.description || s?.text || '').trim().slice(0, 500),
    }))
    .filter((s) => s.description || s.title)
    .slice(0, 12)
    .sort((a, b) => a.order - b.order);

  const conditions = (Array.isArray(raw.conditions) ? raw.conditions : [])
    .map((c) => ({
      description: String(c?.description || c?.text || '').trim().slice(0, 300),
      step_order: Number.isFinite(c?.step_order) ? c.step_order : null,
    }))
    .filter((c) => c.description)
    .slice(0, 8);

  const status =
    raw.status === 'ready' || raw.ready_to_deploy ? 'ready' : 'drafting';

  return {
    version: 1,
    name,
    subtitle,
    connected_tools,
    triggers,
    steps,
    conditions,
    status,
    synthesis_hint: String(raw.synthesis_hint || '').slice(0, 400),
  };
}

/** Turn blueprint into agent_spec.instructions for hosted run. */
export function definitionToAgentSpec(definition, { sourceDescription = '' } = {}) {
  const def = normalizeAgentDefinition(definition);
  const toolIds = new Set(['lykn_searchVault', 'lykn_getBeliefs', 'lykn_getRules', 'lykn_pushProjectState']);
  for (const t of def.connected_tools) {
    if (t.id === 'gmail') toolIds.add('lykn_searchVault');
    if (t.id.startsWith('lykn_')) toolIds.add(t.id);
  }

  const lines = [
    `You are the hosted agent "${def.name}".`,
    def.subtitle ? `Pipeline: ${def.subtitle}` : '',
    '',
    '## Triggers',
    ...def.triggers.map((t) => `- ${t.description}`),
    '',
    '## Steps (execute in order)',
    ...def.steps.map((s) => `${s.order}. **${s.title}**: ${s.description}`),
  ];
  if (def.conditions.length) {
    lines.push('', '## Conditions');
    for (const c of def.conditions) {
      const stepRef = c.step_order ? ` (step ${c.step_order})` : '';
      lines.push(`- ${c.description}${stepRef}`);
    }
  }
  if (def.synthesis_hint) {
    lines.push('', '## LYKN context note', def.synthesis_hint);
  }

  const integrations = def.connected_tools
    .filter((t) => KNOWN_TOOL_IDS.has(t.id) || BUILDER_INTEGRATION_IDS.has(t.id))
    .map((t) => ({
      id: t.id,
      reason: t.reason || `Required for ${t.label}`,
      label: t.label,
      connected: t.connected,
      provider: t.id,
    }));

  return {
    name: def.name,
    description: def.subtitle || sourceDescription.slice(0, 200),
    instructions: lines.filter(Boolean).join('\n').slice(0, 6000),
    tools: [...toolIds].slice(0, 12),
    triggers: ['manual'],
    context_mode: 'full',
    integrations_required: integrations.filter((i) =>
      ['gmail', 'google-calendar', 'google-drive', 'slack', 'notion'].includes(i.id),
    ),
    source_description: sourceDescription,
    agent_definition: def,
    welcome_message: `**${def.name}** is configured. Use **Test run** or **Deploy agent** when ready.`,
  };
}

export function definitionPipelineSubtitle(definition) {
  const tools = (definition?.connected_tools || [])
    .map((t) => t.label || t.id)
    .filter(Boolean);
  if (tools.length) return tools.join(' → ');
  return definition?.subtitle || '';
}
