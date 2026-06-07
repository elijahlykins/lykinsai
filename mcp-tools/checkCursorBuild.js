// ============================================================================
// mcp-tools/checkCursorBuild.js — check on Cursor cloud-agent build(s)
// ============================================================================
// Read. Answers "is Cursor done?", "what's the status of that build", "did the
// build finish / open a PR". Refreshes any still-running builds from the Cloud
// Agents API first, so the status reported is current. Returns the most recent
// builds (or one by id) with status + PR link + a short result summary.

import { jsonContent, errorContent } from './content.js';

export const checkCursorBuildTool = {
  name: 'lykn_check_cursor_build',
  title: 'Check the status of a Cursor build',
  scope: 'read',
  description: [
    'Check on coding builds you handed to Cursor with lykn_build_with_cursor.',
    'Call when the user asks "is Cursor done", "did that build finish", "what\'s',
    'the status of the build", "is the PR up yet", or to recap recent builds.',
    '',
    'Refreshes running builds from Cursor first, so status is current. Returns',
    'the most recent builds (newest first) with: status (running / completed /',
    'failed / cancelled), pr_url (the pull request, when opened), a short result',
    'summary, and the instruction. Read the status back plainly. If a build is',
    'still running, say so — do NOT claim it\'s finished. Only share the pr_url',
    'this returns; never invent one.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      build_id: {
        type: 'string',
        description: 'Optional UUID of a specific build (from lykn_build_with_cursor). Omit to list recent builds.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'How many recent builds to return when no build_id is given (default 5).',
      },
    },
    additionalProperties: false,
  },
  async handler(args = {}, ctx = {}) {
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }

    let getCursorBuilds;
    try {
      ({ getCursorBuilds } = await import('../lib/cursor/cursorBuilds.js'));
    } catch (e) {
      return errorContent(`cursor_builds_unavailable: ${e?.message || e}`);
    }

    const buildId = typeof args.build_id === 'string' && args.build_id.trim() ? args.build_id.trim() : null;
    const limit = Math.max(1, Math.min(20, Number.parseInt(args.limit, 10) || 5));

    const result = await getCursorBuilds({
      client: ctx.supabaseAdmin,
      userId: ctx.userId,
      buildId,
      limit,
    });
    if (!result?.ok) {
      return errorContent(result?.error || 'Could not read your Cursor builds.');
    }

    const builds = (result.builds || []).map((b) => ({
      build_id: b.id,
      status: b.status,
      instruction: String(b.instruction || '').slice(0, 300),
      pr_url: b.pr_url || null,
      agent_url: b.agent_url || null,
      result_summary: b.result_summary ? String(b.result_summary).slice(0, 600) : null,
      error_message: b.error_message || null,
      created_at: b.created_at,
      completed_at: b.completed_at || null,
    }));

    return jsonContent({
      ok: true,
      count: builds.length,
      builds,
      message: builds.length ? null : 'No Cursor builds yet.',
    });
  },
};
