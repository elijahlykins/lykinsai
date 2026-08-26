// ============================================================================
// mcp-tools/memoryTools.js — Chat/voice wrappers for the Memory tool surface
// ============================================================================
// The model never sees a user_id. Ownership is taken from ctx.userId, which
// buildChatToolCtx / buildToolCtx set from the authenticated request.
// Path, type, and write policy stay in server/memory.

import { jsonContent, errorContent } from './content.js';
import {
  memoryList,
  memoryRead,
  memoryPatch,
  memoryCreate,
  memoryForget,
  MEMORY_TOOL_DEFINITIONS,
} from '../server/memory/memoryTools.js';
import { getMemoryStore, invalidateMemoryThreadPath } from '../server/memory/memoryChat.js';

function toolCtx(ctx) {
  if (!ctx?.userId) return { error: 'Unauthorized — no LYKN user resolved.' };
  const store = getMemoryStore(ctx.supabaseAdmin);
  if (!store) return { error: 'Memory store is not configured.' };
  return { store, userId: ctx.userId };
}

function stripModelUserId(args) {
  if (!args || typeof args !== 'object') return {};
  const { userId: _userId, user_id: _user_id, ownerId: _ownerId, ...rest } = args;
  return rest;
}

function wrap(name, title, scope, handler) {
  const def = MEMORY_TOOL_DEFINITIONS.find((d) => d.name === name);
  return {
    name,
    title,
    scope,
    description: def?.description || title,
    inputSchema: def?.parameters || { type: 'object', properties: {}, additionalProperties: false },
    handler,
  };
}

export const memoryListTool = wrap('memory_list', 'List compact personal memories', 'read', async (_args, ctx) => {
  const m = toolCtx(ctx);
  if (m.error) return errorContent(m.error);
  return jsonContent(await memoryList(m));
});

export const memoryReadTool = wrap('memory_read', 'Read one personal memory document', 'read', async (args, ctx) => {
  const m = toolCtx(ctx);
  if (m.error) return errorContent(m.error);
  const { path, maxTokens } = stripModelUserId(args);
  return jsonContent(await memoryRead(m, { path, maxTokens }));
});

export const memoryPatchTool = wrap('memory_patch', 'Patch a personal memory document', 'write', async (args, ctx) => {
  const m = toolCtx(ctx);
  if (m.error) return errorContent(m.error);
  const { path, patch, sourceType, expectedVersion, meta } = stripModelUserId(args);
  const out = await memoryPatch(m, { path, patch, sourceType, expectedVersion, meta });
  if (out.ok) invalidateMemoryThreadPath(m.userId, path);
  return jsonContent(out);
});

export const memoryCreateTool = wrap('memory_create', 'Create a personal memory document', 'write', async (args, ctx) => {
  const m = toolCtx(ctx);
  if (m.error) return errorContent(m.error);
  const { path, markdown, sourceType, name, description, meta } = stripModelUserId(args);
  const out = await memoryCreate(m, { path, markdown, sourceType, name, description, meta });
  if (out.ok) invalidateMemoryThreadPath(m.userId, path);
  return jsonContent(out);
});

export const memoryForgetTool = wrap('memory_forget', 'Forget a personal memory', 'write', async (args, ctx) => {
  const m = toolCtx(ctx);
  if (m.error) return errorContent(m.error);
  const { path, mode, patch, sourceType, confirmHardDelete, meta } = stripModelUserId(args);
  const out = await memoryForget(m, { path, mode, patch, sourceType, confirmHardDelete, meta });
  if (out.ok) invalidateMemoryThreadPath(m.userId, path);
  return jsonContent(out);
});

export const MEMORY_CHAT_TOOLS = [
  memoryListTool,
  memoryReadTool,
  memoryPatchTool,
  memoryCreateTool,
  memoryForgetTool,
];

export const MEMORY_CHAT_TOOLS_BY_NAME = Object.freeze(
  Object.fromEntries(MEMORY_CHAT_TOOLS.map((t) => [t.name, t])),
);
