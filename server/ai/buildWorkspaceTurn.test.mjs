// Run: node --test server/ai/buildWorkspaceTurn.test.mjs
//
// The build-surface decision. Build mode on desktop arms both the artifact
// force-spec and the workspace; these tests pin the deterministic precedence
// rule (the workspace owns fresh webapp/game builds, artifact edits keep the
// artifact pipeline) and the guidance wording the model steers by.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  armBuildWorkspaceTools,
  buildWorkspaceGuidance,
  workspaceOwnsFreshBuild,
} from './buildWorkspaceTurn.js';
import { BUILD_WORKSPACE_TOOL_NAMES } from '../../mcp-tools/localTools.js';

// ---------------------------------------------------------------------------
// workspaceOwnsFreshBuild — the precedence rule
// ---------------------------------------------------------------------------

test('workspace owns a fresh webapp build when armed', () => {
  assert.equal(
    workspaceOwnsFreshBuild({
      buildWorkspace: true,
      artifactToolName: 'lykn_build_react_artifact',
      activeArtifactEditable: false,
    }),
    true,
  );
});

test('editing an open chat artifact stays on the artifact pipeline', () => {
  assert.equal(
    workspaceOwnsFreshBuild({
      buildWorkspace: true,
      artifactToolName: 'lykn_build_react_artifact',
      activeArtifactEditable: true,
    }),
    false,
  );
});

test('without the workspace armed, the artifact build is untouched', () => {
  assert.equal(
    workspaceOwnsFreshBuild({
      buildWorkspace: false,
      artifactToolName: 'lykn_build_react_artifact',
      activeArtifactEditable: false,
    }),
    false,
  );
});

test('non-webapp deliverables (decks, charts, video) keep their builders', () => {
  for (const tool of ['lykn_build_template', 'lykn_generate_chart', 'lykn_render_video', null]) {
    assert.equal(
      workspaceOwnsFreshBuild({
        buildWorkspace: true,
        artifactToolName: tool,
        activeArtifactEditable: false,
      }),
      false,
      String(tool),
    );
  }
});

// ---------------------------------------------------------------------------
// Guidance — what the model is told about the surface
// ---------------------------------------------------------------------------

test('guidance states workspace ownership and claims games explicitly', () => {
  const guidance = buildWorkspaceGuidance();
  assert.match(guidance, /THE WORKSPACE IS THE BUILD SURFACE/);
  // Games were the wobble's worst case — the rule must name them.
  assert.match(guidance, /games are ALWAYS workspace projects/i);
  // The old judgment-call wording must not come back.
  assert.ok(!/Choose the right build surface/i.test(guidance));
  // Continuity: follow-ups stay in the same project.
  assert.match(guidance, /follow-up[^.]*same project folder/i);
  // The one remaining artifact job is edits of existing chat artifacts.
  assert.match(guidance, /editing an artifact that already lives in this chat/i);
  // The warehouse-edit failure: the model claimed it lacked file access on a
  // turn where the tools were armed. The guidance forbids that claim outright.
  assert.match(guidance, /armed on THIS turn/);
  assert.match(guidance, /never tell the user you lack access/i);
  assert.match(guidance, /never ask them to resend/i);
});

test('guidance still teaches the dock-install finish', () => {
  const guidance = buildWorkspaceGuidance();
  assert.match(guidance, /local_install_app/);
  assert.match(guidance, /npm run build/);
  // Dock icons: the model must pick one that matches what the app IS.
  assert.match(guidance, /`icon` custom to what the app actually IS/);
  // Creative compute: headless Blender/Godot, and the render-check loop that
  // makes the model look at its own pixels before shipping.
  assert.match(guidance, /CREATIVE COMPUTE/);
  assert.match(guidance, /blender --background --python/);
  assert.match(guidance, /Godot projects are plain text/);
  // Code-first CAD: a kernel for dimensioned parts, with numeric verification.
  assert.match(guidance, /CODE-FIRST CAD/);
  assert.match(guidance, /uv run --with build123d/);
  assert.match(guidance, /export STEP/);
  assert.match(guidance, /B-rep\s+solids ARE the dimensions/);
  assert.match(guidance, /RENDER, LOOK, REFINE/);
  assert.match(guidance, /Never ship a visual you have not looked at/);
  // Reference-true modeling: real dimensions, orthographic proportion checks,
  // same-angle compares against an attached reference, numeric read-back.
  assert.match(guidance, /MODEL THE REAL THING/);
  assert.match(guidance, /orthographic side\/front\//);
  assert.match(guidance, /Trace, don't glance/);
  assert.match(guidance, /background plates in the orthographic views/);
  assert.match(guidance, /reference image is ground truth/);
  assert.match(guidance, /ONE side-by-side image/);
  assert.match(guidance, /read the resulting measurements back/);
  // Measured color matching + physically-based gradients.
  assert.match(guidance, /MATCH COLOR BY MEASURING/);
  assert.match(guidance, /sRGB→linear/);
  assert.match(guidance, /RMSE/);
  assert.match(guidance, /PBR materials \+ HDRI lighting/);
  // Post-install lifecycle: the app opens itself; the dev server must not be
  // left running with no off switch.
  assert.match(guidance, /OPENS on their screen automatically/);
  assert.match(guidance, /STOP the project's dev server/);
  // Edit flow: re-run the project so the user sees the update live, then ASK
  // before shipping the update to the dock — never reinstall unprompted.
  assert.match(guidance, /EDITS TO AN EXISTING PROJECT/);
  assert.match(guidance, /RE-RUN it/);
  assert.match(guidance, /do NOT reinstall it unprompted/);
  assert.match(guidance, /asking whether to install the update/);
  assert.match(guidance, /correct way to END an edit turn/);
  assert.match(guidance, /here is what I did/);
  assert.match(guidance, /Do not recap the journey/);
});

test('guidance teaches one server per project and the auto-replace restart', () => {
  const guidance = buildWorkspaceGuidance();
  assert.match(guidance, /ONE SERVER PER PROJECT/);
  assert.match(guidance, /auto-replaces the old instance/);
  assert.match(guidance, /local_stop_process/);
});

// ---------------------------------------------------------------------------
// Tool arming
// ---------------------------------------------------------------------------

test('armBuildWorkspaceTools adds every workspace tool exactly once', () => {
  const armed = armBuildWorkspaceTools(['lykn_generate_image', 'local_read_file']);
  for (const name of BUILD_WORKSPACE_TOOL_NAMES) {
    assert.equal(armed.filter((n) => n === name).length, 1, name);
  }
  assert.ok(armed.includes('lykn_generate_image'));
  assert.ok(armed.includes('local_install_app'));
});

test('armBuildWorkspaceTools re-arms lykn_generate_image for textures', () => {
  // Chat resolution strips the generate tool everywhere (image generation is
  // Imagine-only), so workspace turns must add it back themselves — the
  // workspace guidance promises it for textures/sprites/concept art.
  const armed = armBuildWorkspaceTools([]);
  assert.equal(armed.filter((n) => n === 'lykn_generate_image').length, 1);
});
