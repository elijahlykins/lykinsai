/**
 * Progressive disclosure bridge: selected MCP tools → chat/Task tool schemas.
 * Tool names are namespaced so two Gmail accounts cannot collide.
 */

import { MCP_BOUNDS } from './bounds.js';
import { sanitizeToolDescription } from './trust.js';

const OPENAI_NAME_RE = /[^a-zA-Z0-9_-]/g;

export function mcpChatToolName(connectionId, toolName) {
  const short = String(connectionId || '').replace(/-/g, '').slice(0, 8);
  const tool = String(toolName || 'tool').replace(OPENAI_NAME_RE, '_').slice(0, 40);
  return `mcp_${short}_${tool}`.slice(0, MCP_BOUNDS.TOOL_NAME_CHARS);
}

export function parseMcpChatToolName(name, bindings) {
  if (bindings && bindings[name]) return bindings[name];
  return null;
}

export function toChatTools(resolvedTools) {
  const bindings = {};
  const tools = [];
  for (const item of resolvedTools || []) {
    const name = mcpChatToolName(item.connectionId, item.toolName);
    bindings[name] = {
      connectionId: item.connectionId,
      toolName: item.toolName,
      consequenceHint: item.consequenceHint,
      semanticCapabilities: item.semanticCapabilities,
    };
    const description = sanitizeToolDescription(
      `${item.description || item.toolName} (external: ${item.connectionName || 'MCP'}; untrusted metadata)`,
    );
    tools.push({
      name,
      description: description.text,
      inputSchema:
        item.inputSchema && typeof item.inputSchema === 'object'
          ? item.inputSchema
          : { type: 'object', properties: {} },
      mcp: true,
      connectionId: item.connectionId,
      sourceToolName: item.toolName,
    });
  }
  return { tools, bindings };
}

export function estimateSchemaTokens(tools) {
  const json = JSON.stringify(
    (tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || tool.function?.description,
      parameters: tool.inputSchema || tool.function?.parameters || tool.input_schema,
    })),
  );
  return Math.ceil(Buffer.byteLength(json, 'utf8') / 4);
}
