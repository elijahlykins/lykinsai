// ============================================================================
// mcp-tools/communicateWithModel.js — talk to ANY of the user's published
// custom models (sub-agents) and get a report back.
// ============================================================================
// Unlike lykn_delegate_to_sub_model (MAIN AGENT ONLY, gated to a configured
// roster), this tool lets the in-app chat AND the voice agent reach ANY
// published model the user built — main agent or not — by id or by name, send
// it a message/task, and receive the sub-agent's report synchronously.
//
// The sub-agent is run via runSubModelDelegate, whose system prompt instructs
// it to report on its activity (who it is, its purpose, what it did / can do)
// alongside completing the task. So "communicating with a sub-agent" always
// yields a report — that's the whole point of this tool.
//
// Self-contained: the handler resolves the model and runs the delegate using
// ctx.supabaseAdmin + ctx.userId, so it works identically from the chat agent
// loop and the voice /api/ai/realtime/tool dispatch without extra ctx wiring.
// Server libs are dynamically imported to avoid any module load-order coupling
// with mcp-tools/index.js.

import { jsonContent, errorContent } from './index.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const communicateWithModelTool = {
  name: 'lykn_communicate_with_model',
  title: 'Communicate with one of the user\'s models',
  scope: 'write',
  description: [
    'Send a message or task to ONE of the user\'s published custom models (a',
    'sub-agent) and get its report back. Works for ANY published model — it does',
    'NOT have to be in a main-agent roster, and you do not have to be the main',
    'agent to call it.',
    '',
    'SYNCHRONOUS: this runs the model now and returns its full report in the same',
    'call. There is no background processing — relay the report immediately and',
    'never tell the user you will follow up "when it finishes".',
    '',
    'WHEN TO CALL:',
    '  • The user asks you to "ask my <model> about X", "check in with <model>",',
    '    "have <model> do Y", or "what is <model> working on / what can it do".',
    '  • The work needs that specialist (implement / refactor / debug a codebase,',
    '    a long loop they own) and you cannot finish it yourself this turn.',
    '',
    'WHEN NOT TO CALL:',
    '  • You already have the answer, a folder/file listing, or a tool that can',
    '    finish the ask this turn (local_list_dir, local_read_file, web search).',
    '  • "What is in this folder", summaries, explanations, and ordinary Q&A.',
    '',
    'Identify the target by model_id (preferred — get it from lykn_listCustomModels)',
    'or by model_name. The model reports back on its activity and result; relay',
    'that report to the user.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      model_id: {
        type: 'string',
        description: 'UUID of the published model to talk to (preferred; from lykn_listCustomModels).',
      },
      model_name: {
        type: 'string',
        description: 'Name of the published model (used when model_id is unknown; case-insensitive).',
      },
      message: {
        type: 'string',
        description: 'What to ask or assign the model — a question, task, or "report on what you do / are working on".',
      },
      context: {
        type: 'string',
        description: 'Optional background from the conversation the model needs.',
      },
    },
    required: ['message'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const message = String(args.message || '').trim();
    if (!message) return errorContent('missing_message: message is required.');

    const rawId = String(args.model_id || '').trim();
    const rawName = String(args.model_name || '').trim();
    if (!rawId && !rawName) {
      return errorContent('missing_target: provide model_id or model_name.');
    }

    let getCustomModel;
    let listPublishedCustomModels;
    let runSubModelDelegate;
    try {
      ({ getCustomModel, listPublishedCustomModels } = await import('../custom-models-service.js'));
      ({ runSubModelDelegate } = await import('../lib/modelBuilder/runSubModelDelegate.js'));
    } catch (e) {
      return errorContent(`communication_unavailable: ${e?.message || e}`);
    }

    // Resolve the target model: by id when it looks like a UUID, else by name
    // (exact case-insensitive match first, then a single substring match).
    let model = null;
    try {
      if (rawId && UUID_RE.test(rawId)) {
        model = await getCustomModel(ctx.supabaseAdmin, ctx.userId, rawId);
      }
      if (!model && (rawName || rawId)) {
        const needle = (rawName || rawId).toLowerCase();
        const published = await listPublishedCustomModels(ctx.supabaseAdmin, ctx.userId, { limit: 50 });
        model =
          published.find((m) => String(m.name || '').toLowerCase() === needle) ||
          published.filter((m) => String(m.name || '').toLowerCase().includes(needle))[0] ||
          null;
      }
    } catch (e) {
      return errorContent(`model_lookup_failed: ${e?.message || e}`);
    }

    if (!model) {
      return errorContent('model_not_found: no published model matched that id or name.');
    }
    if (model.status !== 'published') {
      return errorContent(`model_not_published: "${model.name}" is a draft. Publish it in Model Builder first.`);
    }

    const result = await runSubModelDelegate({
      client: ctx.supabaseAdmin,
      userId: ctx.userId,
      subModelId: model.id,
      taskInstruction: message,
      context: args.context,
    });
    if (!result?.ok) {
      return errorContent(result?.message || result?.error || 'communication_failed');
    }

    return jsonContent({
      ok: true,
      model_id: result.sub_model_id || model.id,
      model_name: result.sub_model_name || model.name,
      report: result.report,
    });
  },
};
