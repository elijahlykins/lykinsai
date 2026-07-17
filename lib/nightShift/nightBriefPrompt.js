export const NIGHT_BRIEF_SYSTEM = [
  'You are LYKN Night Shift — a project steward that prepares a concise morning',
  'handoff while the user sleeps. You write for a busy builder opening their',
  'project dashboard or overlay at the start of the day.',
  '',
  'Rules:',
  '  • Be specific — reference actual task titles, state keys, and blockers from',
  '    the input. Never invent work that is not in the data.',
  '  • Keep the brief under 1200 characters total.',
  '  • Use clean Markdown: a ## Today focus line, then 3–5 bullet points max.',
  '  • If nothing meaningful changed and there are no open tasks, say so briefly',
  '    in one sentence — do not pad with generic advice.',
  '  • Do not greet the user or sign off.',
  '  • Flag stale open tasks (untouched 7+ days) when present.',
].join('\n');

/**
 * @param {object} ctx
 * @param {string} ctx.projectName
 * @param {string|null} ctx.projectDescription
 * @param {Array<{ state_key: string, state_value: string, set_by_client: string|null, created_at: string }>} ctx.stateRows
 * @param {Array<{ title: string, status: string, priority: string, due_at: string|null, updated_at: string }>} ctx.todos
 * @param {Array<{ title: string, start_at: string, end_at: string|null }>} ctx.upcomingEvents
 * @param {Array<{ state_key: string, state_value: string, created_at: string }>} ctx.recentPushes
 * @param {Array<{ title: string, status: string, result_summary?: string|null }>} [ctx.stewardItems]
 */
export function buildNightBriefUserMessage(ctx) {
  const lines = [
    `PROJECT: ${ctx.projectName}`,
  ];
  if (ctx.projectDescription) {
    lines.push(`DESCRIPTION: ${ctx.projectDescription}`);
  }

  lines.push('', '--- CURRENT PROJECT STATE (latest per key) ---');
  if (!ctx.stateRows.length) {
    lines.push('(none yet)');
  } else {
    for (const row of ctx.stateRows) {
      if (row.state_key === 'morning_brief') continue;
      lines.push(
        `[${row.state_key}] ${row.state_value}` +
          (row.set_by_client ? ` (via ${row.set_by_client})` : ''),
      );
    }
  }

  lines.push('', '--- OPEN TASKS ---');
  if (!ctx.todos.length) {
    lines.push('(none)');
  } else {
    for (const t of ctx.todos) {
      const due = t.due_at ? ` due ${t.due_at}` : '';
      lines.push(`- [${t.priority}] ${t.title} (${t.status})${due}`);
    }
  }

  lines.push('', '--- UPCOMING EVENTS (next 7 days) ---');
  if (!ctx.upcomingEvents.length) {
    lines.push('(none)');
  } else {
    for (const e of ctx.upcomingEvents) {
      lines.push(`- ${e.title} @ ${e.start_at}`);
    }
  }

  lines.push('', '--- RECENT PUSHES (last 24h, excluding morning_brief) ---');
  if (!ctx.recentPushes.length) {
    lines.push('(none)');
  } else {
    for (const p of ctx.recentPushes) {
      lines.push(`- ${p.state_key}: ${p.state_value.slice(0, 240)}`);
    }
  }

  lines.push('', '--- STEWARD QUEUE (Night Shift) ---');
  if (!ctx.stewardItems?.length) {
    lines.push('(none)');
  } else {
    for (const s of ctx.stewardItems) {
      const kind = s.execution_kind && s.execution_kind !== 'research' ? ` (${s.execution_kind})` : '';
      const extra = s.result_summary ? `: ${s.result_summary.slice(0, 120)}` : '';
      const blocked = s.blocked_reason ? ` — blocked: ${s.blocked_reason.slice(0, 80)}` : '';
      lines.push(`- [${s.status}]${kind} ${s.title}${extra}${blocked}`);
    }
  }

  lines.push(
    '',
    'Write the morning brief Markdown now.',
  );
  return lines.join('\n');
}
