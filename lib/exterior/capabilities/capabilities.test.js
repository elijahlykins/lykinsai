import test from 'node:test';
import assert from 'node:assert/strict';
import { manageFile } from './fileOps.js';
import { buildTemplate, applySectionEdits } from './buildTemplate.js';
import { buildSpreadsheet, applySpreadsheetEdits } from './spreadsheet.js';
import { buildReactArtifact, applyArtifactEdits } from './buildReactArtifact.js';
import { buildSlideshowHtml } from './templateExports.js';
import { httpRequest } from './httpRequest.js';
import { mimeTypeForFilename } from '../capabilityStorage.js';

test('manageFile converts markdown to html', async () => {
  const result = await manageFile({
    action: 'convert',
    filename: 'doc.md',
    content: '# Title\n\nHello **world**',
    source_format: 'markdown',
    target_format: 'html',
  });
  assert.equal(result.ok, true);
  assert.equal(result.format, 'html');
  assert.match(result.content, /<html>/);
});

test('buildSlideshowHtml produces navigable deck', () => {
  const html = buildSlideshowHtml('Demo', [{ heading: 'One', body: 'Body' }]);
  assert.match(html, /class="slide"/);
  assert.match(html, /Demo/);
});

test('buildTemplate returns schema without auth', async () => {
  const result = await buildTemplate({
    template_type: 'worksheet',
    title: 'Quiz',
    sections: [{ heading: 'Q1', body: '2+2=?', answer_key: '4' }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.section_count, 1);
  assert.match(result.markdown, /Quiz/);
});

test('buildSpreadsheet markdown table', async () => {
  const result = await buildSpreadsheet({
    headers: ['Name', 'Score'],
    rows: [{ Name: 'Ada', Score: 99 }],
    output_format: 'markdown',
  });
  assert.equal(result.ok, true);
  assert.match(result.markdown_table, /Ada/);
});

test('httpRequest blocks localhost', async () => {
  const result = await httpRequest({ url: 'http://127.0.0.1:3001/api' });
  assert.equal(result.error, 'url_not_allowed');
});

test('mimeTypeForFilename maps extensions', () => {
  assert.match(mimeTypeForFilename('out.pptx'), /presentation/);
  assert.match(mimeTypeForFilename('out.csv'), /csv/);
});

test('applyArtifactEdits patches unique find', () => {
  const patched = applyArtifactEdits('const x = 1;\nconst y = 2;', [
    { find: 'const y = 2;', replace: 'const y = 3;' },
  ]);
  assert.equal(patched.ok, true);
  assert.match(patched.code, /y = 3/);
  assert.match(patched.code, /x = 1/);
});

test('buildReactArtifact multi-file project bundles and edits by path', async () => {
  const created = await buildReactArtifact({
    title: 'Game',
    files: [
      {
        path: 'App.jsx',
        content:
          'import Player from "./game/Player.js";\nexport default function App(){ return <Player name="A" />; }\n',
      },
      {
        path: 'game/Player.js',
        content: 'export default function Player({ name }){ return <div className="p-2">{name}</div>; }\n',
      },
    ],
    todos: [{ id: '1', content: 'Wire player', status: 'completed' }],
  });
  assert.equal(created.ok, true);
  assert.equal(created.multi_file, true);
  assert.equal(created.file_count, 2);
  assert.ok(Array.isArray(created.artifact_files));
  assert.match(created.preview_html || '', /__lyknRequire|lykn-artifact-source/);

  const patched = await buildReactArtifact(
    {
      title: 'Game',
      edits: [{ path: 'game/Player.js', find: 'name="A"', replace: 'name="B"' }],
    },
    { activeArtifactFiles: created.artifact_files, activeArtifactEntry: 'App.jsx' },
  );
  // find is in App.jsx, not Player — should fail
  assert.equal(patched.ok, false);

  const patchedOk = await buildReactArtifact(
    {
      title: 'Game',
      edits: [{ path: 'App.jsx', find: 'name="A"', replace: 'name="B"' }],
    },
    { activeArtifactFiles: created.artifact_files, activeArtifactEntry: 'App.jsx' },
  );
  assert.equal(patchedOk.ok, true);
  const appFile = patchedOk.artifact_files.find((f) => f.path === 'App.jsx');
  assert.match(appFile.content, /name="B"/);
});

test('buildReactArtifact requires edits when artifact is open', async () => {
  const base =
    'export default function App() {\n  return <div className="p-4 text-blue-600">Hello</div>;\n}\n';
  const rejected = await buildReactArtifact(
    { title: 'App', code: base.replace('Hello', 'Hi there friend') },
    { activeArtifactCode: base },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'edits_required');

  // full_rewrite without allowFullRewrite must not bypass the guard
  const rewriteRejected = await buildReactArtifact(
    { title: 'App', code: base.replace('blue-600', 'rose-500'), full_rewrite: true },
    { activeArtifactCode: base, allowFullRewrite: false },
  );
  assert.equal(rewriteRejected.ok, false);
  assert.equal(rewriteRejected.error, 'edits_required');

  const patched = await buildReactArtifact(
    { title: 'App', edits: [{ find: 'Hello', replace: 'Hi' }] },
    { activeArtifactCode: base },
  );
  assert.equal(patched.ok, true);
  assert.match(patched.artifact_code || '', /Hi/);
  assert.equal(patched.edits_applied, 1);

  // Silent style churn on content edits is rejected
  const styleRejected = await buildReactArtifact(
    { title: 'App', edits: [{ find: 'text-blue-600', replace: 'text-rose-500' }] },
    { activeArtifactCode: base, allowFullRewrite: false, allowStyleChange: false },
  );
  assert.equal(styleRejected.ok, false);
  assert.equal(styleRejected.error, 'style_rewrite');

  // Explicit color asks are allowed
  const styleOk = await buildReactArtifact(
    { title: 'App', edits: [{ find: 'text-blue-600', replace: 'text-rose-500' }] },
    { activeArtifactCode: base, allowStyleChange: true },
  );
  assert.equal(styleOk.ok, true);
  assert.match(styleOk.artifact_code || '', /rose-500/);
});

test('applySectionEdits overlays one slide body', () => {
  const patched = applySectionEdits(
    [
      { id: 's1', heading: 'One', body: 'Alpha' },
      { id: 's2', heading: 'Two', body: 'Beta' },
    ],
    [{ id: 's2', body: 'Beta updated' }],
  );
  assert.equal(patched.ok, true);
  assert.equal(patched.sections[0].body, 'Alpha');
  assert.equal(patched.sections[1].body, 'Beta updated');
});

test('buildTemplate rejects full sections over open deck without full_rewrite', async () => {
  const active = [
    { id: 's1', heading: 'One', body: 'Alpha' },
    { id: 's2', heading: 'Two', body: 'Beta' },
  ];
  const rejected = await buildTemplate(
    {
      template_type: 'presentation',
      title: 'Deck',
      sections: [
        { id: 's1', heading: 'One', body: 'Alpha rewritten' },
        { id: 's2', heading: 'Two', body: 'Beta' },
      ],
    },
    { activeArtifactSections: active },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'section_edits_required');

  const ok = await buildTemplate(
    {
      template_type: 'presentation',
      title: 'Deck',
      section_edits: [{ find: 'Alpha', replace: 'Alpha fixed' }],
    },
    { activeArtifactSections: active },
  );
  assert.equal(ok.ok, true);
  assert.match(ok.sections[0].body, /Alpha fixed/);
  assert.equal(ok.sections[1].body, 'Beta');
});

test('buildTemplate style-only reuses open sections', async () => {
  const active = [{ id: 's1', heading: 'One', body: 'Keep me' }];
  const ok = await buildTemplate(
    { template_type: 'presentation', title: 'Deck', font: 'georgia', theme: 'blue' },
    { activeArtifactSections: active },
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.style_only, true);
  assert.equal(ok.sections[0].body, 'Keep me');
  assert.equal(ok.font, 'georgia');
});

test('applySpreadsheetEdits updates a cell by column name', () => {
  const patched = applySpreadsheetEdits(
    ['Name', 'Score'],
    [['Ada', 99]],
    [{ row: 0, column: 'Score', value: 100 }],
  );
  assert.equal(patched.ok, true);
  assert.equal(patched.rows[0][1], 100);
});

test('manageFile requires edits when file artifact is open', async () => {
  const active = '<html><body>Hello</body></html>';
  const rejected = await manageFile(
    { action: 'edit', filename: 'a.html', content: '<html><body>Hi</body></html>' },
    { activeArtifactContent: active },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'edits_required');

  const ok = await manageFile(
    { action: 'edit', filename: 'a.html', edits: [{ find: 'Hello', replace: 'Hi' }] },
    { activeArtifactContent: active },
  );
  assert.equal(ok.ok, true);
  assert.match(ok.content, /Hi/);
});
