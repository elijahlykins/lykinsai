import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOpenAiTools } from './chatTools.js';
import { isSurgicalEditCtx, slimChatToolsForSurgicalEdit } from './artifactEditSchema.js';

test('surgical edit ctx is off for fresh builds and authorized rewrites', () => {
  assert.equal(isSurgicalEditCtx(null), false);
  assert.equal(isSurgicalEditCtx({}), false);
  assert.equal(isSurgicalEditCtx({ editingArtifact: true, allowFullRewrite: true }), false);
  assert.equal(isSurgicalEditCtx({ editingArtifact: true }), true);
  assert.equal(isSurgicalEditCtx({ activeArtifactCode: 'export default function App(){return null}' }), true);
  assert.equal(
    isSurgicalEditCtx({
      activeArtifactFiles: [{ path: 'App.jsx', content: 'export default function App(){return null}' }],
    }),
    true,
  );
});

test('edit-turn React schema drops code/files so the model cannot re-stream the app', () => {
  const full = buildOpenAiTools(['lykn_build_react_artifact']);
  assert.ok(full?.[0]?.function?.parameters?.properties?.code);
  assert.ok(full?.[0]?.function?.parameters?.properties?.files);

  const slim = buildOpenAiTools(['lykn_build_react_artifact'], [], { surgicalEdit: true });
  const props = slim[0].function.parameters.properties;
  assert.equal(props.code, undefined);
  assert.equal(props.files, undefined);
  assert.equal(props.full_rewrite, undefined);
  assert.ok(props.edits);
  assert.ok(props.file_ops);
  assert.ok(props.title);
  assert.match(slim[0].function.description, /Patch the OPEN React/);
});

test('slim leaves unrelated tools untouched', () => {
  const tools = slimChatToolsForSurgicalEdit([
    { name: 'lykn_web_search', description: 'search', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  ]);
  assert.equal(tools[0].name, 'lykn_web_search');
  assert.ok(tools[0].inputSchema.properties.q);
});
