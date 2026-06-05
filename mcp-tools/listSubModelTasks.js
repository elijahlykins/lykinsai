import { jsonContent, errorContent } from './index.js';

export const listSubModelTasksTool = {
  name: 'lykn_list_sub_model_tasks',
  title: 'List sub-agent tasks',
  scope: 'read',
  description: [
    'MAIN AGENT ONLY. List background tasks you delegated to sub-agents.',
    'Use when the user asks about progress or before re-delegating the same work.',
    'Returns tasks with status pending | running | completed | failed.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        description: 'Optional filter: pending, running, completed, failed, or comma-separated.',
      },
      limit: {
        type: 'integer',
        description: 'Max tasks to return (default 20, max 40).',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const orch = ctx?.orchestration;
    if (!orch?.isMainAgent) {
      return errorContent('not_main_agent: task list is only available on the main agent.');
    }
    const lister = ctx.listSubModelTasks;
    if (typeof lister !== 'function') {
      return errorContent('task_list_unavailable');
    }
    try {
      const tasks = await lister({
        status: args.status,
        limit: args.limit,
      });
      const active = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
      return jsonContent({
        ok: true,
        count: tasks.length,
        active_count: active.length,
        tasks: tasks.map((t) => ({
          task_id: t.id,
          sub_model_id: t.sub_model_id,
          sub_model_name: t.sub_model_name,
          status: t.status,
          task_instruction: t.task_instruction,
          report: t.status === 'completed' ? t.report : undefined,
          error: t.status === 'failed' ? t.error_message : undefined,
          created_at: t.created_at,
          completed_at: t.completed_at,
        })),
      });
    } catch (e) {
      return errorContent(e?.message || 'task_list_failed');
    }
  },
};
