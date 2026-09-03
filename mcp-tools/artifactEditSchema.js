// Surgical-edit tool schemas for an OPEN artifact / installed app.
//
// Fresh builds expose `code` / `files` as the primary arguments, so a forced
// lykn_build_react_artifact call dumps the whole app (tens of KB) even when
// the prompt said "edits only". That re-stream is what makes Build-mode
// refine and "edit this app" sit until the 10-minute SSE kill.
//
// When a source is already open and the user did not ask to rebuild, drop
// those dump fields from the schema so the model can only send patches.

const DROP_PROPERTIES = Object.freeze({
  lykn_build_react_artifact: Object.freeze(['code', 'files', 'full_rewrite']),
  lykn_build_template: Object.freeze(['sections', 'full_rewrite']),
  lykn_manage_file: Object.freeze(['content', 'full_rewrite']),
  lykn_build_spreadsheet: Object.freeze(['headers', 'rows', 'full_rewrite']),
});

const EDIT_DESCRIPTIONS = Object.freeze({
  lykn_build_react_artifact:
    'Patch the OPEN React app/artifact. Pass the same title plus `edits` ' +
    '([{find, replace, path?}]) and/or `file_ops` ([{op:"write"|"delete", path, content?}]). ' +
    'Copy each `find` verbatim from [ARTIFACT_OPEN]. ONE call covering every change. ' +
    'Do not resubmit the full source.',
  lykn_build_template:
    'Patch the OPEN deck/doc. Pass the same title and template_type plus `section_edits` ' +
    '(and theme/font only if asked). Do not resubmit the full sections array.',
  lykn_manage_file:
    'Patch the OPEN file with `edits` ([{find, replace}]). Do not resubmit full content.',
  lykn_build_spreadsheet:
    'Patch the OPEN sheet with `cell_edits`. Do not resubmit full headers/rows.',
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function slimOneTool(tool) {
  const drop = DROP_PROPERTIES[tool.name];
  if (!drop) return tool;
  const schema = cloneJson(tool.inputSchema && typeof tool.inputSchema === 'object'
    ? tool.inputSchema
    : { type: 'object', properties: {} });
  const properties = schema.properties && typeof schema.properties === 'object'
    ? schema.properties
    : {};
  for (const key of drop) delete properties[key];
  schema.properties = properties;
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter((key) => !drop.includes(key));
  }
  return {
    ...tool,
    description: EDIT_DESCRIPTIONS[tool.name] || tool.description,
    inputSchema: schema,
  };
}

export function isSurgicalEditCtx(ctx) {
  if (!ctx || typeof ctx !== 'object') return false;
  if (ctx.allowFullRewrite === true) return false;
  if (ctx.editingArtifact === true) return true;
  if (typeof ctx.activeArtifactCode === 'string' && ctx.activeArtifactCode.trim()) return true;
  if (Array.isArray(ctx.activeArtifactFiles) && ctx.activeArtifactFiles.length > 0) return true;
  if (
    ctx.activeArtifactFiles &&
    typeof ctx.activeArtifactFiles === 'object' &&
    !Array.isArray(ctx.activeArtifactFiles) &&
    Object.keys(ctx.activeArtifactFiles).length > 0
  ) {
    return true;
  }
  if (Array.isArray(ctx.activeArtifactSections) && ctx.activeArtifactSections.length > 0) return true;
  if (typeof ctx.activeArtifactContent === 'string' && ctx.activeArtifactContent.trim()) return true;
  if (Array.isArray(ctx.activeArtifactRows) && ctx.activeArtifactRows.length > 0) return true;
  return false;
}

export function slimChatToolsForSurgicalEdit(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  return tools.map(slimOneTool);
}
