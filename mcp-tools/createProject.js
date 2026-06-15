// ============================================================================
// mcp-tools/createProject.js — user-authorized project creation (in-app only)
// ============================================================================
// IMPORTANT: this tool is deliberately NOT exported from mcp-tools/index.js, so
// it is NOT part of the external MCP surface (Claude Desktop / Cursor / etc.).
// External clients keep the user-only restriction enforced by
// lykn_setActiveProject (creation_not_allowed) — that guard exists to stop
// outside clients spawning duplicate blank projects on paraphrased names.
//
// The IN-PRODUCT LYKN assistant (text chat via chatTools.js, and voice via the
// realtime tool dispatch) is different: it only reaches for this AFTER the user
// explicitly agrees to its suggestion to start a project. At that point the
// user is the real author, so we record the project exactly like a
// synthesis-UI creation (created_by='user') — it shows up under Projects and
// becomes the active focus. Name-key dedup means "yes, start that" can't fork
// the same project twice.

import { jsonContent, errorContent, requireWrite } from './index.js';
import { createUserAuthorizedProject } from '../lib/projectWriteTarget.js';

export const createProjectTool = {
  name: 'lykn_createProject',
  title: 'Create a new project the user just agreed to start',
  scope: 'write',
  description: [
    'Create a NEW project in the user\'s LYKN workspace and make it the active',
    'focus. The new project appears under "Projects" for the user immediately.',
    '',
    'CONFIRM FIRST — this is the ONLY rule that matters:',
    '  Never create a project unprompted. The flow is always:',
    '    1. You SUGGEST it in plain language ("This feels like its own',
    '       project — want me to start one called \'<name>\'?").',
    '    2. The user explicitly AGREES ("yes", "sure", "do it", "start it").',
    '    3. THEN you call lykn_createProject({ name }).',
    '  If the user did not clearly say yes, do not call this — just keep',
    '  talking. One suggestion per turn; if they decline, drop it.',
    '',
    'Before creating, make sure it is actually new: if the work matches an',
    'existing project, call lykn_setActiveProject with that project_id instead',
    '(use lykn_listProjects / lykn_resolveProject to check). Creating with a',
    'name that already exists just re-activates that project (no duplicate).',
    '',
    'Pick a short, descriptive name (3-8 words) from what the user is working',
    'on. Optionally pass a one-sentence description. After it is created,',
    'confirm in plain language (e.g. "Started that — it is in your projects now")',
    'and you can push working memory to it with lykn_pushProjectState.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Short, descriptive project name, 3-8 words. E.g. "Q1 fundraising deck", "Spatial UI prototype".',
      },
      description: {
        type: 'string',
        description: 'Optional one-sentence summary of what the project is about (<=320 chars).',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async handler(args = {}, ctx) {
    const writeBlock = requireWrite(ctx);
    if (writeBlock) return writeBlock;
    if (!ctx?.supabaseAdmin || !ctx?.userId) {
      return errorContent('Unauthorized — no LYKN user resolved.');
    }
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) return errorContent('name is required — pass a short, descriptive project name.');

    const result = await createUserAuthorizedProject(ctx.supabaseAdmin, ctx.userId, {
      name,
      description: args?.description,
      client: 'lykn-synthesis',
    });
    if (!result.ok) {
      return errorContent(`Could not create the project (${result.error}).`);
    }

    const p = result.project;
    return jsonContent({
      ok: true,
      was_created: result.was_created,
      project: {
        id: p.id,
        name: p.name,
        description: p.description,
        status: p.status,
      },
      message: result.was_created
        ? `Created project "${p.name}" and set it as the active focus. It now appears under the user's Projects.`
        : `A project named "${p.name}" already existed — reactivated it and set it as the active focus.`,
    });
  },
};
