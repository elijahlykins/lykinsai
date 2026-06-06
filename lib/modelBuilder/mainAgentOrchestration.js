/**
 * Main-agent orchestration helpers (one main per user delegates to sub-models).
 */

import { getCustomModel, listPublishedCustomModels } from '../../custom-models-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readIsMainAgent(model) {
  if (!model) return false;
  if (model.isMainAgent === true || model.is_main_agent === true) return true;
  const meta = model.metadata;
  if (meta && (meta.is_main_agent === true || meta.isMainAgent === true)) return true;
  return false;
}

export function sanitizeSubModelIds(raw, { selfId } = {}) {
  const self = String(selfId || '').trim();
  const ids = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of ids) {
    const id = String(item || '').trim();
    if (!UUID_RE.test(id)) continue;
    if (self && id === self) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= 12) break;
  }
  return out;
}

export function readSubModelIds(model) {
  if (!model) return [];
  const meta = model.metadata && typeof model.metadata === 'object' ? model.metadata : {};
  return sanitizeSubModelIds(
    model.subModelIds ?? meta.sub_model_ids ?? meta.subModelIds ?? [],
    { selfId: model.id },
  );
}

/**
 * @param {import('../../custom-models-service.js').default} client
 * @param {string} userId
 * @param {string[]} subModelIds
 */
export async function loadSubModelRoster(client, userId, subModelIds) {
  const roster = [];
  for (const id of subModelIds || []) {
    try {
      const row = await getCustomModel(client, userId, id);
      if (!row || row.status !== 'published') continue;
      const description = String(row.metadata?.description || '').trim();
      roster.push({
        id: row.id,
        name: row.name,
        description: description.slice(0, 240),
      });
    } catch {
      /* skip missing */
    }
  }
  return roster;
}

/**
 * Roster of ALL the user's published models, for the case where there is no
 * configured main agent: the default LYKN chat + the voice agent act as the
 * user's main agent over everything they've published. Unlike loadSubModelRoster
 * (which takes an explicit id list), this pulls every published model.
 *
 * @param {string} [opts.excludeId] — drop this model from the roster (a custom
 *   model shouldn't list itself as a sub-agent).
 */
export async function loadPublishedRoster(client, userId, { excludeId = null, limit = 16 } = {}) {
  if (!client || !userId) return [];
  let models = [];
  try {
    models = await listPublishedCustomModels(client, userId, {
      limit: Math.min(Math.max(Number(limit) || 16, 1), 50),
    });
  } catch {
    return [];
  }
  const self = String(excludeId || '').trim();
  const roster = [];
  for (const m of models || []) {
    if (self && String(m.id) === self) continue;
    const description = String(m.metadata?.description || '').replace(/\s+/g, ' ').trim();
    roster.push({ id: m.id, name: m.name, description: description.slice(0, 200) });
    if (roster.length >= limit) break;
  }
  return roster;
}

/**
 * Lightweight "you are the main agent" block for the DEFAULT LYKN chat and the
 * voice agent (neither is a configured main agent, so they get the synchronous
 * communicate-with-model path rather than the async background-task toolset).
 *
 * @param {{id:string,name:string,description?:string}[]} roster
 * @param {{ voice?: boolean }} [opts] — voice uses the spoken tool names.
 */
export function formatDefaultMainAgentBlock(roster, opts = {}) {
  if (!roster?.length) return '';
  const voice = opts.voice === true;
  const communicateTool = voice ? 'communicate_with_model' : 'lykn_communicate_with_model';
  const listTool = voice ? 'list_custom_models' : 'lykn_listCustomModels';
  const lines = [
    '[MAIN_AGENT]',
    "You are LYKN, the user's MAIN agent — you coordinate the specialized models they have built.",
    `When a request fits one of these models better than answering it yourself, hand it the task with ` +
      `${communicateTool} (pass the model_id) and ${voice
        ? 'read the report it returns back to the user, briefly'
        : 'relay the report it returns to the user'}.`,
    `${communicateTool} is SYNCHRONOUS: it runs that model immediately and returns its full report in the ` +
      'SAME step. Wait for the result, then relay it now. It is NOT a background job — nothing keeps running ' +
      'after the call returns, so NEVER tell the user you will "get back to them when <model> finishes" or that ' +
      'a model is "still working". If you have not just received a report, you have not contacted the model ' +
      `yet — call ${communicateTool} now. If it returns an error (e.g. the model is a draft / not published), ` +
      'say so plainly.',
    `Call ${listTool} to rediscover these models or check what each one is for. ` +
      'Do not delegate casual chat or things you can answer well yourself.',
    '',
    "The user's models (sub-agents) you can call:",
  ];
  for (const sub of roster) {
    lines.push(`- ${sub.name} (model_id: ${sub.id})${sub.description ? ` — ${sub.description}` : ''}`);
  }
  return lines.join('\n').trim();
}

function truncateForPrompt(text, max = 320) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function formatMainAgentOrchestrationBlock(mainModel, roster, extras = {}) {
  if (!readIsMainAgent(mainModel) || !roster?.length) return '';
  const { activeTasks = [], completedReports = [] } = extras;
  const lines = [
    '[MAIN_AGENT_ORCHESTRATION]',
    `You are "${mainModel.name}" — the user's MAIN agent.`,
    'You coordinate specialized sub-agents. When work fits a sub-agent better than doing it yourself,',
    'delegate with lykn_delegate_to_sub_model.',
    '',
    'DEFAULT: run_in_background=true so the user can keep chatting while sub-agents work in parallel.',
    'Tell the user who you assigned and what they are working on. Do NOT stall waiting unless they ask.',
    'Use run_in_background=false only for quick lookups that finish in seconds.',
    '',
    'Check lykn_list_sub_model_tasks when the user asks about progress.',
    'When [SUB_AGENT_REPORTS] appears below, those sub-agents finished — summarize for the user.',
    'Do not delegate casual chat or simple questions you can answer directly.',
    '',
    'Sub-agents you may delegate to:',
  ];
  for (const sub of roster) {
    const desc = sub.description ? ` — ${sub.description}` : '';
    lines.push(`- ${sub.name} (sub_model_id: ${sub.id})${desc}`);
  }
  lines.push('');
  lines.push(
    'Delegation tips: one focused task per call; include relevant context;',
    'you may delegate to multiple sub-agents in one turn (each runs in parallel).',
  );

  if (activeTasks.length) {
    lines.push('', '[SUB_AGENT_ACTIVE]');
    for (const t of activeTasks) {
      lines.push(
        `- ${t.sub_model_name || 'Sub-agent'} (task_id: ${t.id}, status: ${t.status}): ${truncateForPrompt(t.task_instruction, 200)}`,
      );
    }
  }

  if (completedReports.length) {
    lines.push('', '[SUB_AGENT_REPORTS]');
    lines.push('These sub-agents finished since your last turn — tell the user and use the reports:');
    for (const t of completedReports) {
      lines.push('');
      lines.push(`## ${t.sub_model_name || 'Sub-agent'} (task_id: ${t.id})`);
      lines.push(`Task: ${truncateForPrompt(t.task_instruction, 240)}`);
      lines.push(`Report:\n${String(t.report || '').trim()}`);
    }
  }

  return lines.join('\n').trim();
}
