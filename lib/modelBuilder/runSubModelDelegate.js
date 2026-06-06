/**
 * Run a single delegated task against a published sub-model (non-streaming).
 */

import { resolveCustomModelChatContext } from './customModelChat.js';
import { applyCustomModelOverlayToPrompt } from './customModelChat.js';
import { buildCustomModelChatOverlay } from './customModelPrompt.js';

const DELEGATE_MODEL = 'gpt-4.1-nano';
const MAX_TASK_CHARS = 6000;
const MAX_CONTEXT_CHARS = 4000;
const MAX_REPORT_TOKENS = 1200;

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

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DELEGATE_MODEL,
        temperature: 0.3,
        max_tokens: MAX_REPORT_TOKENS,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        error: 'sub_model_call_failed',
        message: `Sub-model call failed (${res.status}). ${errText.slice(0, 200)}`,
      };
    }
    const data = await res.json();
    const report = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!report) {
      return { ok: false, error: 'empty_report', message: 'Sub-model returned an empty report.' };
    }
    return {
      ok: true,
      sub_model_id: model.id,
      sub_model_name: model.name,
      report,
    };
  } catch (e) {
    return {
      ok: false,
      error: 'sub_model_call_error',
      message: e?.message || String(e),
    };
  }
}
