// Guards against the worst outcome of an edit turn: the user asks for a
// change, watches it think, and gets a paragraph with nothing edited.
//
// This is a real regression that shipped: once large artifacts started
// arriving as a structure map instead of inlined source, the model would
// spend its hop reading, narrate what it was about to do, and stop.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReactSourceView, SOURCE_INLINE_LIMIT } from './artifactSourceView.js';

/** A multi-file project of roughly `chars` total, like an installed app. */
function project(chars) {
  const per = Math.floor(chars / 4);
  const body = (name) =>
    `import React from "react";\n\nexport default function ${name}() {\n` +
    '  // pad pad pad pad pad pad pad pad pad pad pad\n'.repeat(Math.max(1, Math.floor(per / 46))) +
    '  return null;\n}\n';
  return [
    { path: 'App.jsx', content: body('App') },
    { path: 'components/Editor.jsx', content: body('Editor') },
    { path: 'components/Sidebar.jsx', content: body('Sidebar') },
    { path: 'components/Icons.jsx', content: body('Icons') },
  ];
}

test('an ordinary installed app still gets its source inlined', () => {
  // The regression: the threshold sat at 24KB, so a normal multi-file app —
  // which the old code inlined without trouble — silently switched to the
  // outline path and edits stopped landing. Anything the previous code could
  // show in full must still be shown in full.
  const files = project(40000);
  const view = buildReactSourceView({ files, entry: 'App.jsx' });
  assert.equal(view.mode, 'inline');
  for (const f of files) {
    assert.ok(view.block.includes(f.content), `${f.path} must be inlined verbatim`);
  }
});

test('the inline limit is at least what the old code could display', () => {
  // The old path inlined up to 60,000 chars before truncating. Dropping below
  // that trades a working path for a cheaper one.
  assert.ok(
    SOURCE_INLINE_LIMIT >= 60000,
    `inline limit ${SOURCE_INLINE_LIMIT} is below the 60,000 the old path handled`,
  );
});

test('only genuinely oversized artifacts take the outline path', () => {
  const view = buildReactSourceView({ files: project(SOURCE_INLINE_LIMIT + 20000), entry: 'App.jsx' });
  assert.equal(view.mode, 'outline');
  assert.match(view.block, /lykn_read_artifact_source/);
});

// --- The prompt half of the same regression -------------------------------
//
// Outline mode is only safe if the model is TOLD the source is a map and that
// reads are free. Those instructions were added to the preview-popup branch
// but not the installed-app branch, so an app edit got a map, an instruction
// to "copy from [ARTIFACT_OPEN]", and nothing to copy — and "ONE CALL PER
// TURN" read as "you already spent your call" after the forced read.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const routeSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'chatStream.routes.js'),
  'utf8',
);

test('the outline instruction is not nested inside one branch of the edit prompt', () => {
  const marker = 'THIS SOURCE WAS NOT INLINED';
  assert.equal(
    routeSource.split(marker).length - 1,
    1,
    'the outline instruction should exist exactly once, ahead of the appEditTurn branch',
  );
  const instructionAt = routeSource.indexOf(marker);
  const branchAt = routeSource.indexOf('(appEditTurn\n');
  assert.ok(instructionAt > 0 && branchAt > 0);
  assert.ok(
    instructionAt < branchAt,
    'the outline instruction must precede the appEditTurn ternary so BOTH paths get it',
  );
});

test('reads are declared free of the one-builder-call rule', () => {
  assert.match(routeSource, /Reads do NOT count against the one-builder-call rule/);
  assert.match(routeSource, /are not builder calls and do not count/);
  // The bare phrasing that read as "you already used your call" is gone.
  assert.ok(
    !/`ONE CALL PER TURN\. `/.test(routeSource),
    'bare "ONE CALL PER TURN" is ambiguous once a read can precede the patch',
  );
});

test('both edit paths warn that ending without a builder call applies nothing', () => {
  assert.equal(
    routeSource.split('leaves the user with NO edit').length - 1,
    2,
    'both the installed-app and preview-popup branches need this line',
  );
});

test('outline mode forces the reader on installed-app edits too', () => {
  // The gate was `!artifactToolName`, which excluded a Build-armed app edit —
  // exactly the case that broke.
  assert.match(
    routeSource,
    /artifactSourceOutlined && activeArtifactEditable\s*\n\s*\? 'lykn_read_artifact_source'/,
  );
});
