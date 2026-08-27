// Tool-context builder for Chat + voice MCP dispatch.
let supabaseAdmin = null;

export function bindChatToolCtx(deps) {
  supabaseAdmin = deps.supabaseAdmin;
}

// ============================================================================
// LYKN TOOL CONTEXT
// ============================================================================
// The tools in mcp-tools/* are invoked from two in-app
// surfaces: the text chat (via buildChatToolCtx + runChatTool in
// mcp-tools/chatTools.js) and the realtime voice session (via the runMcp
// dispatcher on /api/ai/realtime/tool, which uses buildToolCtx below).
//
// Both are JWT-only — the user's own signed-in session. LYKN no longer
// exposes these tools to outside AI clients, so there is no bearer-token
// transport, no scope negotiation, and no per-client attribution: every
// call is attributed to 'lykn-chat'.
export function buildToolCtx(req) {
  return {
    supabaseAdmin,
    userId: req.user?.id || null,
    clientLabel: String(req.headers['user-agent'] || '').slice(0, 240),
    attribSurface: 'lykn-chat',
  };
}

// Tools whose successful execution should invalidate the cached in-LYKN
// [CURRENT_PROJECT] prompt block, so a project mutation is visible to the
// next chat turn instead of 90 seconds later when the TTL expires.
export const PROJECT_WRITE_TOOLS = new Set([
  'lykn_createProject',
  'lykn_setActiveProject',
  'lykn_pushProjectState',
  'lykn_updateProject',
  'lykn_deleteProject',
  'lykn_mergeProjects',
  'lykn_addProjectNeurons',
  'lykn_removeProjectNeurons',
  'lykn_uploadToProject',
]);
