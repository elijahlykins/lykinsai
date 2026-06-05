import { jsonContent, errorContent } from './index.js';

export const delegateToSubModelTool = {
  name: 'lykn_delegate_to_sub_model',
  title: 'Delegate task to a sub-agent',
  scope: 'write',
  description: [
    'MAIN AGENT ONLY. Assign a focused task to one of your configured sub-agents.',
    '',
    'WHEN TO CALL:',
    '  • The user needs specialized work that matches a sub-agent in your roster.',
    '  • You need a sub-agent to research, draft, analyze, or execute a bounded task.',
    '',
    'WHEN NOT TO CALL:',
    '  • Casual conversation or questions you can answer directly.',
    '  • Sub-model id not in your orchestration roster.',
    '',
    'MODES:',
    '  • run_in_background=true (DEFAULT): starts work in parallel; returns task_id immediately.',
    '    Tell the user the sub-agent is working. Check lykn_list_sub_model_tasks or wait for [SUB_AGENT_REPORTS].',
    '  • run_in_background=false: blocks until the sub-agent returns a report (quick tasks only).',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      sub_model_id: {
        type: 'string',
        description: 'UUID of the sub-agent from your MAIN_AGENT_ORCHESTRATION roster.',
      },
      task_instruction: {
        type: 'string',
        description: 'Clear, bounded task for the sub-agent (what to do and what to return).',
      },
      context: {
        type: 'string',
        description: 'Optional background from the conversation the sub-agent needs.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'When true (default), run asynchronously so the user can keep chatting.',
      },
    },
    required: ['sub_model_id', 'task_instruction'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const orch = ctx?.orchestration;
    if (!orch?.isMainAgent) {
      return errorContent('not_main_agent: delegation is only available on the main agent.');
    }
    const subId = String(args.sub_model_id || '').trim();
    const allowed = new Set((orch.subModelIds || []).map((id) => String(id)));
    if (!subId || !allowed.has(subId)) {
      return errorContent('sub_model_not_allowed: that id is not in your sub-agent roster.');
    }

    const runInBackground = args.run_in_background !== false;
    const subName =
      (orch.roster || []).find((r) => String(r.id) === subId)?.name || '';

    if (runInBackground) {
      const creator = ctx.createSubModelTask;
      const enqueuer = ctx.enqueueSubModelTask;
      if (typeof creator !== 'function' || typeof enqueuer !== 'function') {
        return errorContent('async_delegation_unavailable');
      }
      const created = await creator({
        subModelId: subId,
        subModelName: subName,
        taskInstruction: args.task_instruction,
        context: args.context,
      });
      if (!created?.ok) {
        return errorContent(created?.message || created?.error || 'task_create_failed');
      }
      enqueuer({ taskId: created.task.id });
      return jsonContent({
        ok: true,
        mode: 'background',
        task_id: created.task.id,
        sub_model_id: subId,
        sub_model_name: subName || created.task.sub_model_name,
        status: 'pending',
        message: `${subName || 'Sub-agent'} is working on this in the background.`,
      });
    }

    const runner = ctx.runSubModelDelegate;
    if (typeof runner !== 'function') {
      return errorContent('delegation_unavailable: server delegate runner not configured.');
    }
    const result = await runner({
      subModelId: subId,
      taskInstruction: args.task_instruction,
      context: args.context,
    });
    if (!result?.ok) {
      return errorContent(result?.message || result?.error || 'delegation_failed');
    }
    return jsonContent({ ok: true, mode: 'sync', ...result });
  },
};
