import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDesktopMcpApps,
  resolveDesktopMcpAvailable,
  desktopMcpIntent,
  desktopMcpConnectIntent,
  armDesktopMcpTools,
  withoutDesktopMcpTools,
  buildDesktopMcpGuidance,
} from './desktopMcpTurn.js';

const APPS = [
  { name: 'Blender', toolCount: 17, tools: ['get_scene_info', 'execute_blender_code'] },
  { name: 'Ableton Live', toolCount: 9, tools: [] },
];

test('resolveDesktopMcpApps sanitizes the report and is empty for browser asks', () => {
  const apps = resolveDesktopMcpApps({ desktopMcpApps: APPS });
  assert.equal(apps.length, 2);
  assert.equal(apps[0].name, 'Blender');
  assert.deepEqual(resolveDesktopMcpApps({ desktopMcpApps: APPS }, { browserAsk: true }), []);
  assert.deepEqual(resolveDesktopMcpApps({}), []);
});

test('naming a connected app is intent; nothing connected is not', () => {
  assert.equal(desktopMcpIntent('make me a donut in blender', APPS), true);
  assert.equal(desktopMcpIntent('what is a good 3d tool', APPS), false);
  assert.equal(desktopMcpIntent('make me a donut in blender', []), false);
});

test('arming appends the registry tools once and never mutates the input', () => {
  const base = ['lykn_web_search'];
  const armed = armDesktopMcpTools(base);
  assert.deepEqual(armed, [
    'lykn_web_search',
    'local_mcp_search_tools',
    'local_mcp_call_tool',
    'local_mcp_catalog',
    'local_mcp_connect',
  ]);
  assert.deepEqual(base, ['lykn_web_search']);
  assert.deepEqual(armDesktopMcpTools(armed), armed);
  assert.deepEqual(withoutDesktopMcpTools(armed), ['lykn_web_search']);
});

test('bridge availability is its own signal, off for browser asks', () => {
  assert.equal(resolveDesktopMcpAvailable({ desktopMcpAvailable: true }), true);
  assert.equal(resolveDesktopMcpAvailable({ desktopMcpAvailable: true }, { browserAsk: true }), false);
  assert.equal(resolveDesktopMcpAvailable({}), false);
  assert.equal(resolveDesktopMcpAvailable({ desktopMcpAvailable: 'yes' }), false);
});

test('connect intent catches the ways users ask to hook up a new tool', () => {
  assert.equal(desktopMcpConnectIntent('connect to blender and make a character'), true);
  assert.equal(desktopMcpConnectIntent('can you hook me up to my notion'), true);
  assert.equal(desktopMcpConnectIntent('add an mcp server for godot'), true);
  assert.equal(desktopMcpConnectIntent('what apps can you control on my mac'), true);
  assert.equal(desktopMcpConnectIntent('can you control ableton'), true);
  assert.equal(desktopMcpConnectIntent('set up the figma integration'), true);
  assert.equal(desktopMcpConnectIntent('what is the capital of france'), false);
  assert.equal(desktopMcpConnectIntent('write me a poem about autumn'), false);
  assert.equal(desktopMcpConnectIntent(''), false);
});

test('guidance lists the live apps and forbids reach denials', () => {
  const section = buildDesktopMcpGuidance(APPS);
  assert.match(section, /\[DESKTOP_MCP_APPS\]/);
  assert.match(section, /- Blender \(17 tools: get_scene_info, execute_blender_code, …\)/);
  assert.match(section, /- Ableton Live \(9 tools\)/);
  assert.match(section, /local_mcp_search_tools/);
  assert.match(section, /local_mcp_call_tool/);
  assert.match(section, /never tell the user you cannot reach their machine/);
  assert.equal(buildDesktopMcpGuidance([]), '');
  assert.equal(buildDesktopMcpGuidance(undefined), '');
});

test('guidance demands COMPLETE builds, not first passes', () => {
  const section = buildDesktopMcpGuidance(APPS);
  assert.match(section, /FINISH WHAT YOU START/);
  assert.match(section, /COMPLETE thing/);
  assert.match(section, /list the parts the finished result needs/);
  assert.match(section, /Never end the turn by describing what you would do next/);
  assert.match(section, /Verify the final result/);
});

test('guidance teaches reference-true, dimensionally exact modeling', () => {
  const section = buildDesktopMcpGuidance(APPS);
  assert.match(section, /MODEL THE REAL THING, NOT A MEMORY OF IT/);
  // Dimensions before geometry, in real units.
  assert.match(section, /Dimensions first/);
  assert.match(section, /real units/);
  // Proportions judged orthographically, not from a beauty angle.
  assert.match(section, /ORTHOGRAPHIC side\/front\/top renders/);
  // The reference-image compare loop: same angle, name mismatches, iterate.
  assert.match(section, /reference image is GROUND TRUTH/);
  assert.match(section, /SAME\s+angle as the reference/);
  assert.match(section, /name the 3 biggest mismatches/);
  assert.match(section, /look back at it between rounds/);
  // Trace over in-viewport reference plates / blueprints, the pro workflow.
  assert.match(section, /TRACE, DON'T GLANCE/);
  assert.match(section, /background image empties/);
  assert.match(section, /blueprint sheets exist online/);
  // Compare in a single composite image, not two images far apart in context.
  assert.match(section, /composite the\s+render and the reference into ONE/);
  // Ratios measured off the reference photo itself.
  assert.match(section, /read ratios off the photo/);
  assert.match(section, /Eyes judge shape; numbers judge proportion/);
  // Curvature technique + CAD-grade numeric verification.
  assert.match(section, /subdivision surfaces/);
  assert.match(section, /never stacks of scaled primitives/);
  assert.match(section, /EXACTNESS/);
  assert.match(section, /READ BACK the resulting measurements/);
  assert.match(section, /measurement check is a tool call, not a guess/);
});

test('guidance teaches measured color/light matching, not eyeballing', () => {
  const section = buildDesktopMcpGuidance(APPS);
  assert.match(section, /MATCH COLOR AND LIGHT BY MEASURING, NOT BY EYE/);
  // Exact pixel sampling from the reference, converted to linear.
  assert.match(section, /read exact pixel RGB values programmatically/);
  assert.match(section, /sRGB→linear/);
  assert.match(section, /thousands of reds and the photo tells you which one/);
  // Gradients are reflections: physically-based recreation, never painted.
  assert.match(section, /Gradients on real surfaces are usually LIGHT, not paint/);
  assert.match(section, /HDRI environment/);
  assert.match(section, /never paint reflections into a texture/);
  // Objective closing of the loop: sampled deltas + one scalar metric.
  assert.match(section, /sample the SAME regions\s+in your render/);
  assert.match(section, /magick compare -metric RMSE/);
  // Pixel-ratio dimension matching between reference and render.
  assert.match(section, /Dimension-match through pixels/);
  assert.match(section, /ratios agree/);
});

test('connect playbook rides along whenever the bridge is present', () => {
  // Zero connections + connect intent: the playbook alone.
  const zero = buildDesktopMcpGuidance([], { connectArmed: true });
  assert.match(zero, /\[DESKTOP_MCP_CONNECT\]/);
  assert.match(zero, /local_mcp_catalog/);
  assert.match(zero, /local_mcp_connect/);
  assert.match(zero, /env_required/);
  assert.match(zero, /NEVER tell the user to go configure servers in Settings/);
  assert.doesNotMatch(zero, /\[DESKTOP_MCP_APPS\]/);
  // Connected apps + bridge: both blocks.
  const both = buildDesktopMcpGuidance(APPS, { connectArmed: true });
  assert.match(both, /\[DESKTOP_MCP_APPS\]/);
  assert.match(both, /\[DESKTOP_MCP_CONNECT\]/);
});
