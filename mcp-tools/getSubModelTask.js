import { jsonContent, errorContent } from './index.js';

export const getSubModelTaskTool = {
  name: 'lykn_get_sub_model_task',
  title: 'Get sub-agent task',
  scope: 'read',
  description: [
    'MAIN AGENT ONLY. Fetch one delegated sub-agent task by task_id.',
    'Use to read the full report when a task completed or diagnose a failure.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'UUID returned when you delegated the task.',
      },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const orch = ctx?.orchestration;
    if (!orch?.isMainAgent) {
      return errorContent('not_main_agent');
    }
    const getter = ctx.getSubModelTask;
    if (typeof getter !== 'function') {
      return errorContent('task_get_unavailable');
    }
    const taskId = String(args.task_id || '').trim();
    if (!taskId) return errorContent('missing_task_id');
    try {
      const task = await getter(taskId);
      if (!task) return errorContent('task_not_found');
      return jsonContent({
        ok: true,
        task: {
          task_id: task.id,
          sub_model_id: task.sub_model_id,
          sub_model_name: task.sub_model_name,
          status: task.status,
          task_instruction: task.task_instruction,
          context: task.context,
          report: task.report,
          error: task.error_message,
          created_at: task.created_at,
          started_at: task.started_at,
          completed_at: task.completed_at,
        },
      });
    } catch (e) {
      return errorContent(e?.message || 'task_get_failed');
    }
  },
};
