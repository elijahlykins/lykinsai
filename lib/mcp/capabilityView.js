/**
 * Group classified tools into a human capability view.
 * Do not dump raw JSON Schema by default.
 */

import { CONSEQUENCE, parseCapability } from './capabilityRegistry.js';

const DOMAIN_LABELS = {
  communication: 'Communication',
  documents: 'Documents',
  calendar: 'Calendar',
  projects: 'Projects',
  source_control: 'Source control',
  crm: 'CRM',
  knowledge: 'Knowledge',
  permissions: 'Permissions',
  generic: 'Other',
};

const VERB_LABELS = {
  read: 'Read',
  search: 'Search',
  write: 'Draft / write',
  send: 'Send',
  create: 'Create',
  update: 'Update',
  delete: 'Delete',
};

function approvalLabel(consequence) {
  if (consequence === CONSEQUENCE.DESTRUCTIVE || consequence === CONSEQUENCE.SENSITIVE) {
    return 'requires approval';
  }
  if (consequence === CONSEQUENCE.CONSEQUENTIAL) return 'requires approval';
  return null;
}

export function groupConnectionCapabilities(classifiedTools = []) {
  const groups = new Map();
  for (const tool of classifiedTools || []) {
    const caps = tool.semanticCapabilities || tool.capabilities || [];
    const cap = parseCapability(caps[0] || '');
    const domain = cap?.domain || 'generic';
    const verb = cap?.verb || 'read';
    const resource = cap?.resource || 'tool';
    if (!groups.has(domain)) {
      groups.set(domain, {
        domain,
        label: DOMAIN_LABELS[domain] || domain,
        verbs: [],
      });
    }
    const group = groups.get(domain);
    const existing = group.verbs.find((item) => item.verb === verb && item.resource === resource);
    const row = {
      verb,
      resource,
      label: VERB_LABELS[verb] || verb,
      consequence: tool.consequenceHint || tool.consequence || CONSEQUENCE.READ,
      approval: approvalLabel(tool.consequenceHint || tool.consequence),
      toolName: tool.toolName || tool.serverToolName,
    };
    if (!existing) group.verbs.push(row);
  }
  return [...groups.values()];
}

export function publicClassifiedTool(tool) {
  if (!tool) return null;
  return {
    name: tool.toolName || tool.serverToolName || tool.name,
    description: tool.description || '',
    capabilities: tool.semanticCapabilities || tool.capabilities || [],
    consequence: tool.consequenceHint || tool.consequence || CONSEQUENCE.READ,
    confidence: tool.confidence ?? null,
  };
}
