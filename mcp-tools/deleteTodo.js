// ============================================================================
// mcp-tools/deleteTodo.js — permanently remove a to-do (chat/voice)
// ============================================================================
// Write. Hard-deletes a row from lykn_todos. Use this when the user wants the
// task GONE from the list entirely ("delete that todo", "remove it from my
// list"). For "I finished it" prefer lykn_updateTodo with status:'completed'
// (keeps it in history); for "never mind" prefer status:'cancelled'. The id
// comes from lykn_listTodos. Scoped to the caller's own rows (handler filters
// on user_id; RLS enforces it under JWT).

import { jsonContent, errorContent } from './index.js';

export const deleteTodoTool = {
  name: 'lykn_deleteTodo',
  title: 'Delete a to-do',
  scope: 'write',
  description: [
    'Permanently delete a to-do. Get its id from lykn_listTodos first. Use this',
    'when the user clearly wants it removed from the list ("delete that",',
    '"take it off my list"). If they FINISHED it, prefer lykn_updateTodo with',
    'status "completed" (keeps a record); if they changed their mind, prefer',
    'status "cancelled". Confirm the deletion in plain language afterwards.',
    'This cannot be undone.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The to-do id to delete (from lykn_listTodos).',
      },
    },
    required: ['id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const id = String(args?.id || '').trim();
    if (!id) return errorContent('id is required — call lykn_listTodos to find the task first.');

    const { data, error } = await ctx.supabaseAdmin
      .from('lykn_todos')
      .delete()
      .eq('id', id)
      .eq('user_id', ctx.userId)
      .select('id, title')
      .maybeSingle();

    if (error) {
      console.warn('[mcp:deleteTodo]', error.message);
      return errorContent(`todo delete failed: ${error.message}`);
    }
    if (!data) {
      return errorContent('No to-do found with that id (it may not exist or not belong to you).');
    }

    return jsonContent({
      ok: true,
      message: `Deleted "${data.title}" from your to-do list.`,
      deleted_id: data.id,
    });
  },
};
