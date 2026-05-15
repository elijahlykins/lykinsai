// ============================================================================
// mcp-tools/index.js — registry of MCP tools that expose the synthesis layer
// ============================================================================
// One source of truth for "what can outside AI clients (Claude Desktop,
// Cursor, Claude Code, ChatGPT custom GPT, etc.) do with LYKN."
//
// Each tool follows the same shape so:
//   • mcp-server.js can register them all in a loop
//   • the REST mirror in server.js can wrap them in plain HTTP routes
//   • the admin panel can show per-tool usage without hardcoding names
//
// Tool shape:
//   {
//     name        : 'lykn_getBeliefs'              // namespaced (underscore — Claude Desktop rejects dots in tool names per `^[a-zA-Z0-9_-]{1,64}$`)
//     title       : 'Get the user\'s active beliefs'
//     description : Long, LLM-facing prose describing WHEN to call it.
//                  This shows up in Claude / Cursor / etc. and is the
//                  single biggest determinant of whether the model uses
//                  the tool well. Spend tokens here, not in handler logs.
//     scope       : 'read' | 'write'
//     inputSchema : JSON Schema describing args
//     async handler(args, ctx) → { content: [{ type: 'text', text: '...' }] }
//                  Returns MCP "content" blocks. The REST mirror unwraps
//                  these into plain JSON.
//   }
//
// ctx fields (set by mcp-server.js / the REST mirror before calling):
//   ctx.supabaseAdmin   — service-role client
//   ctx.userId          — resolved by requireAuthOrMcpToken
//   ctx.attribSurface   — e.g. 'mcp:claude-desktop' for recordRuleApplication
//   ctx.tokenId         — id of the lykn_mcp_tokens row (null on JWT)
//   ctx.clientLabel     — UA / mcp-client-info string for telemetry
//   ctx.log             — opaque logger; see mcp-server.js
//
// All tool files live in this directory and only re-export the tool object.
// Adding a new tool = drop a file in here and re-export it below.

import { getBeliefsTool } from './getBeliefs.js';
import { getRulesTool } from './getRules.js';
import { getFactsTool } from './getFacts.js';
import { searchVaultTool } from './searchVault.js';
import { getContextBlockTool } from './getContextBlock.js';
import { recordRuleApplicationTool } from './recordRuleApplication.js';
import { proposeBeliefTool } from './proposeBelief.js';
import { proposeFactTool } from './proposeFact.js';
import { setActiveProjectTool } from './setActiveProject.js';
import { pushProjectStateTool } from './pushProjectState.js';
import { getProjectStateTool } from './getProjectState.js';
import { listProjectsTool } from './listProjects.js';

export const MCP_TOOLS = [
  // Tier 1 — Core beliefs (governance, ratified)
  getBeliefsTool,
  getRulesTool,
  proposeBeliefTool,
  recordRuleApplicationTool,
  // Tier 2 — Project state (working memory, git-style)
  listProjectsTool,
  setActiveProjectTool,
  pushProjectStateTool,
  getProjectStateTool,
  // Tier 3 — Identity facts (background, light-weight)
  getFactsTool,
  proposeFactTool,
  // Cross-tier helpers
  getContextBlockTool,
  searchVaultTool,
];

export const MCP_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t])),
);

// ---------------------------------------------------------------------------
// Shared helpers used by tool handlers
// ---------------------------------------------------------------------------

/**
 * Wrap a plain JS value as an MCP "content" block. MCP clients render
 * `text` blocks; structured data goes in JSON-encoded text. Cursor /
 * Claude Desktop both support `type: 'text'`. Some clients also support
 * `type: 'json'` natively but the safe baseline is text-with-JSON.
 */
export function jsonContent(value) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value, null, 2) },
    ],
  };
}

export function textContent(text) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
  };
}

export function errorContent(message) {
  return {
    content: [{ type: 'text', text: `Error: ${String(message || 'unknown')}` }],
    isError: true,
  };
}

/**
 * Tools that mutate state guard themselves with this. JWT (web app)
 * requests always have full access; MCP-token requests need the
 * 'write' scope on the token. Mints default to read+write on every
 * plan, so this only fires if the caller explicitly minted a
 * read-only token (e.g. for a third-party they want to give look-only
 * access to).
 */
export function requireWrite(ctx) {
  if (!ctx?.mcpAuth) return null; // JWT path — pass
  const scopes = Array.isArray(ctx.mcpAuth.scopes) ? ctx.mcpAuth.scopes : [];
  if (scopes.includes('write')) return null;
  return errorContent(
    'This tool requires a write-capable token, but the bearer presented is read-only. Re-mint the token from /connections without restricting scopes (the default mint is read+write).',
  );
}
