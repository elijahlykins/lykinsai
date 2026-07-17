export const STEWARD_TRIAGE_SYSTEM = [
  'You expand vague project work items into actionable overnight specs.',
  'Output ONLY valid JSON (no markdown fences):',
  '  { "spec": "<=1200 chars: concrete steps, success criteria, what to research>",',
  '    "blocked": false,',
  '    "blocked_reason": null }',
  'If the title is too vague to act on without user input, set blocked:true and',
  'blocked_reason to one short question for the user.',
].join('\n');

export const STEWARD_TRIAGE_DELEGATE_SYSTEM = [
  'You expand vague project work items into actionable overnight specs and classify how to execute them.',
  'Output ONLY valid JSON (no markdown fences):',
  '  {',
  '    "spec": "<=1200 chars: concrete steps and success criteria>",',
  '    "execution_kind": "research" | "code" | "agent",',
  '    "repo": null or "github.com/org/repo" when execution_kind is code and repo is inferable,',
  '    "blocked": false,',
  '    "blocked_reason": null',
  '  }',
  'execution_kind rules:',
  '  • research — investigate, compare options, write a report (default for vague ideas)',
  '  • code — implement/fix/refactor in a repo (needs a concrete coding task)',
  '  • agent — deep specialist work best handled by a sub-agent (analysis, drafts, audits)',
  'If too vague, set blocked:true with one short question.',
].join('\n');

export const STEWARD_RESEARCH_SYSTEM = [
  'You are LYKN Night Shift executing one scheduled project item overnight.',
  'Use ONLY the vault snippets and web results provided — do not invent facts.',
  'Output ONLY valid JSON (no markdown fences):',
  '  {',
  '    "report": "<=1500 chars markdown: findings + recommended next steps>",',
  '    "subtasks": ["<=5 short todo titles derived from the work"],',
  '    "progress_summary": "<=200 chars one-line project update>",',
  '    "blocked": false,',
  '    "blocked_reason": null',
  '  }',
  'If critical info is missing, set blocked:true with blocked_reason.',
].join('\n');

/**
 * @param {object} ctx
 * @param {string} ctx.title
 * @param {string|null} ctx.projectName
 * @param {Array<{ state_key: string, state_value: string }>} ctx.stateRows
 */
export function buildTriageUserMessage(ctx) {
  const lines = [
    `PROJECT: ${ctx.projectName || 'Project'}`,
    `RAW IDEA: ${ctx.title}`,
    '',
    '--- PROJECT CONTEXT ---',
  ];
  if (!ctx.stateRows?.length) {
    lines.push('(none)');
  } else {
    for (const row of ctx.stateRows.slice(0, 12)) {
      if (row.state_key === 'morning_brief') continue;
      lines.push(`[${row.state_key}] ${row.state_value.slice(0, 400)}`);
    }
  }
  lines.push(
    '',
    ctx.delegateMode
      ? 'Expand this into a concrete overnight spec JSON with execution_kind now.'
      : 'Expand this into a concrete overnight spec JSON now.',
  );
  return lines.join('\n');
}

/**
 * @param {object} ctx
 */
export function buildResearchUserMessage(ctx) {
  const lines = [
    `PROJECT: ${ctx.projectName || 'Project'}`,
    `TASK TITLE: ${ctx.title}`,
    '',
    '--- EXPANDED SPEC ---',
    ctx.spec || '(none)',
    '',
    '--- VAULT MATCHES ---',
  ];
  if (!ctx.vaultSnippets?.length) {
    lines.push('(none)');
  } else {
    for (const v of ctx.vaultSnippets) {
      lines.push(`• ${v.title}: ${v.snippet}`);
    }
  }
  lines.push('', '--- WEB RESULTS ---');
  if (!ctx.webSnippets?.length) {
    lines.push('(none)');
  } else {
    for (const w of ctx.webSnippets) {
      lines.push(`${w.rank}. ${w.title} — ${w.snippet}`);
    }
  }
  lines.push('', 'Produce the research JSON now.');
  return lines.join('\n');
}

export function parseStewardJson(text) {
  const raw = String(text || '').trim();
  const cleaned = raw.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}
