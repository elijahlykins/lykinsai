/**
 * Run a single delegated task against a published sub-model.
 *
 * Sub-agents are no longer a single blind LLM call — they run a BOUNDED
 * tool-calling loop (the same runAgentLoop the in-app chat uses), so a
 * delegated task like "research X online and summarise it" actually browses
 * the web and grounds its report in real results instead of fabricating.
 *
 * Tooling is deliberately constrained: a sub-agent gets its model's CONFIGURED
 * chat tools (what the user enabled in Model Builder) MINUS a safety denylist,
 * PLUS forced web search/fetch (the headline capability). Sub-agents run
 * autonomously with no per-call user consent, so anything that mutates the
 * user's durable LYKN data, projects, vault, reminders, or preferences — and
 * anything that fans out to OTHER models (recursion) — is withheld. Persisting
 * a sub-agent's output stays with the consent-gated user-facing agent that
 * receives the report (it can lykn_saveFileToVault with the user's yes).
 */

import { resolveCustomModelChatContext } from './customModelChat.js';
import { applyCustomModelOverlayToPrompt } from './customModelChat.js';
import { buildCustomModelChatOverlay } from './customModelPrompt.js';

const DELEGATE_MODEL = 'gpt-4.1-nano';
const MAX_TASK_CHARS = 6000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_REPORT_TOKENS = 1200;
const DELEGATE_TIMEOUT_MS = 90_000;

// Tools a sub-agent must NEVER get, even if the model has them configured.
// Two reasons: (1) recursion / fan-out — a sub-agent shouldn't spawn or talk
// to other models; (2) autonomous mutation — sub-agents run without per-call
// user consent, so writes to Markdown Memory, projects, vault, reminders,
// and preferences stay with the consent-gated user-facing agents.
const SUB_AGENT_TOOL_DENYLIST = new Set([
  // recursion / fan-out
  'lykn_delegate_to_sub_model',
  'lykn_list_sub_model_tasks',
  'lykn_get_sub_model_task',
  'lykn_communicate_with_model',
  // synthesis / project writes
  'lykn_pushProjectState',
  'lykn_addProjectNeurons',
  'lykn_removeProjectNeurons',
  'lykn_setActiveProject',
  'lykn_updateProject',
  'lykn_deleteProject',
  'lykn_mergeProjects',
  // vault writes (orchestrator persists, with consent)
  'lykn_createVaultNote',
  'lykn_saveFileToVault',
  'lykn_saveLinkToVault',
  // reminders writes
  'lykn_createReminder',
  'lykn_updateReminder',
  // preference writes
  'lykn_updateUserPreference',
]);

// Always given to a sub-agent regardless of its configured tool set — the
// whole point of sub-agent tooling is that a delegated task can go look
// things up. Mirrors the main-agent web-tool force-injection in server.js.
const SUB_AGENT_FORCED_TOOLS = ['lykn_web_search', 'lykn_web_fetch'];

/**
 * Resolve the safe tool set for a sub-agent run: configured tools minus the
 * denylist, with the forced web tools guaranteed present.
 */
async function resolveSubAgentTools(metadata) {
  let configured = [];
  try {
    const { resolveCustomModelChatTools } = await import('./customModelChatTools.js');
    const cfg = resolveCustomModelChatTools(metadata || {});
    configured = Array.isArray(cfg?.toolNames) ? cfg.toolNames : [];
  } catch {
    configured = [];
  }
  const safe = configured.filter((n) => !SUB_AGENT_TOOL_DENYLIST.has(n));
  for (const t of SUB_AGENT_FORCED_TOOLS) {
    if (!safe.includes(t)) safe.push(t);
  }
  return safe;
}

/**
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.client
 * @param {string} opts.userId
 * @param {string} opts.subModelId
 * @param {string} opts.taskInstruction
 * @param {string} [opts.context]
 * @param {string} [opts.openaiApiKey]
 */
export async function runSubModelDelegate({
  client,
  userId,
  subModelId,
  taskInstruction,
  context = '',
  openaiApiKey,
}) {
  const apiKey = String(openaiApiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    return { ok: false, error: 'delegation_unavailable', message: 'OpenAI API key not configured.' };
  }

  const task = String(taskInstruction || '').trim().slice(0, MAX_TASK_CHARS);
  if (!task) {
    return { ok: false, error: 'missing_task', message: 'task_instruction is required.' };
  }

  const { model, overlay } = await resolveCustomModelChatContext(
    client,
    userId,
    String(subModelId || '').trim(),
  );
  if (!model || model.status !== 'published') {
    return { ok: false, error: 'sub_model_not_found', message: 'Sub-model not found or not published.' };
  }

  const persona = applyCustomModelOverlayToPrompt(
    '',
    overlay?.promptSections?.length ? overlay : buildCustomModelChatOverlay(model),
  );
  const purpose = String(model.metadata?.description || '').trim().slice(0, 240);
  const ctxBlock = String(context || '').trim().slice(0, MAX_CONTEXT_CHARS);
  const system = [
    persona,
    '',
    '[DELEGATED_TASK]',
    `You are "${model.name}", a sub-agent reporting back to the user (relayed by their main agent or voice agent).`,
    purpose ? `Your purpose: ${purpose}` : '',
    'You have TOOLS — including live web search and page fetch — plus whatever',
    'else your model is configured with. USE them to do the real work: search',
    'the web, read pages, run calculations, parse documents, generate files.',
    'Ground every claim, figure, quote, and link in what a tool actually',
    'returned — never fabricate results, sources, or file contents you did not',
    'retrieve or create.',
    'ALWAYS reply as a report on your activity — open by stating who you are and what you handle,',
    'then address the request. If the request is a check-in ("what are you working on", "what can you do"),',
    'report your purpose, the kinds of tasks you take on, and anything relevant you can act on.',
    'If it is a concrete task, complete ONLY that task and report the result. Be thorough but concise.',
    'Return a structured report the caller can forward verbatim — no meta commentary about being an AI sub-agent.',
  ]
    .filter(Boolean)
    .join('\n')
    .trim();

  const userMsg = ctxBlock
    ? `Context from main agent:\n${ctxBlock}\n\nTask:\n${task}`
    : `Task:\n${task}`;

  let runAgentLoop;
  try {
    ({ runAgentLoop } = await import('../../chat-agent-loop.js'));
  } catch (e) {
    return { ok: false, error: 'delegation_unavailable', message: e?.message || String(e) };
  }

  const chatToolNames = await resolveSubAgentTools(model.metadata);

  const toolCtx = {
    supabaseAdmin: client,
    userId,
    attribSurface: 'sub-agent',
    chatModelLabel: model.name,
  };

  let reportBuf = '';
  const toolsUsed = [];

  let loop;
  try {
    loop = await runAgentLoop({
      provider: 'openai',
      model: DELEGATE_MODEL,
      systemPrompt: system,
      userContent: userMsg,
      maxOutputTokens: MAX_REPORT_TOKENS,
      env: { OPENAI_API_KEY: apiKey },
      ctx: toolCtx,
      chatToolNames,
      signal: AbortSignal.timeout(DELEGATE_TIMEOUT_MS),
      onTextChunk: (t) => { if (t) reportBuf += t; },
      onToolCall: (evt) => {
        if (evt && (evt.status === 'done' || evt.status === 'error') && evt.name) {
          toolsUsed.push(evt.name);
        }
      },
    });
  } catch (e) {
    return { ok: false, error: 'sub_model_call_error', message: e?.message || String(e) };
  }

  const report = String(reportBuf || '').trim();
  if (!report) {
    if (loop && loop.ok === false) {
      return {
        ok: false,
        error: 'sub_model_call_failed',
        message: loop.errorMessage || 'Sub-model run failed.',
      };
    }
    return { ok: false, error: 'empty_report', message: 'Sub-model returned an empty report.' };
  }

  return {
    ok: true,
    sub_model_id: model.id,
    sub_model_name: model.name,
    report,
    tools_used: [...new Set(toolsUsed)],
  };
}
