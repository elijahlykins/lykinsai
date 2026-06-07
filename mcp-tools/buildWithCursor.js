// ============================================================================
// mcp-tools/buildWithCursor.js — hand a coding task to a Cursor cloud agent
// ============================================================================
// Write. Launches a Cursor CLOUD AGENT that builds the requested change on a
// Cursor-hosted VM against the server's allowlisted repo and opens a PR. The
// build runs ASYNC (minutes): this tool returns as soon as it's started. The
// server polls for completion and the next voice briefing / chat tells the user
// "Cursor finished X — ready for testing". Deploy stays manual.
//
// Guardrails:
//   • Only call when the user EXPLICITLY asks to build / implement / fix / add
//     something in code. Never on a vague wish.
//   • The repo is fixed server-side (CURSOR_BUILD_REPO) — the model cannot
//     target an arbitrary repo.
//   • The agent opens a PR; it never merges or deploys.

import { jsonContent, errorContent, requireWrite } from './content.js';

export const buildWithCursorTool = {
  name: 'lykn_build_with_cursor',
  title: 'Have Cursor build something (cloud agent → PR)',
  scope: 'write',
  description: [
    'Hand a CODING task to a Cursor cloud agent. It builds the change on a',
    'Cursor-hosted machine against the user\'s connected repo and opens a pull',
    'request for the user to review, test, and deploy.',
    '',
    'WHEN TO CALL: only when the user EXPLICITLY asks you to build, implement,',
    'add, fix, refactor, or change something in their code/app — e.g. "have',
    'Cursor add dark mode", "build a settings page", "fix the login bug",',
    '"get Cursor to start on X". Do NOT call it for questions, planning, or',
    'vague wishes — confirm the concrete task first.',
    '',
    'ASYNC — fire and report: this does NOT wait for the build to finish. It',
    'returns once the build has STARTED. Tell the user it\'s underway and that',
    'you\'ll let them know when it\'s ready for testing. Do NOT claim it\'s done,',
    'and do NOT invent a PR link — only report the agent_url this returns.',
    'Later, the user will be told automatically when it finishes; they can also',
    'ask for status, which you answer with lykn_check_cursor_build.',
    '',
    'The repo is fixed by the server; you only supply the instruction. Write a',
    'clear, self-contained instruction (what to build and any constraints) — the',
    'cloud agent does not see this conversation.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      instruction: {
        type: 'string',
        description:
          'A clear, self-contained description of what to build/change, including any constraints. The cloud agent only sees this text, not the conversation.',
      },
      project_id: {
        type: 'string',
        description:
          'Optional UUID of the LYKN project this build belongs to (so the result is recorded there). Omit to use the active project.',
      },
    },
    required: ['instruction'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    const instruction = String(args.instruction || '').trim();
    if (!instruction) {
      return errorContent('missing_instruction: describe what you want Cursor to build.');
    }

    let launchCursorBuild;
    let getCursorBuildRepo;
    let resolveWriteProjectTarget;
    try {
      ({ launchCursorBuild, getCursorBuildRepo } = await import('../lib/cursor/cursorBuilds.js'));
      ({ resolveWriteProjectTarget } = await import('../lib/projectWriteTarget.js'));
    } catch (e) {
      return errorContent(`cursor_builds_unavailable: ${e?.message || e}`);
    }

    // Capture which project the completed build should report into (best-effort).
    let projectId = null;
    try {
      const { project } = await resolveWriteProjectTarget(ctx, args.project_id || null);
      if (project?.id) projectId = project.id;
    } catch { /* no project — build still runs */ }

    const result = await launchCursorBuild({
      client: ctx.supabaseAdmin,
      userId: ctx.userId,
      instruction,
      projectId,
    });

    if (!result?.ok) {
      return jsonContent({
        ok: false,
        error: result?.error || 'launch_failed',
        message: result?.message || 'Could not start the Cursor build.',
      });
    }

    const build = result.build || {};
    return jsonContent({
      ok: true,
      build_id: build.id || null,
      status: 'running',
      repo: build.repo || (getCursorBuildRepo ? getCursorBuildRepo() : null),
      agent_url: build.agent_url || null,
      message:
        result.message ||
        'Build started on Cursor. It runs in the background and opens a pull request when done — I\'ll let you know when it\'s ready for testing.',
    });
  },
};
