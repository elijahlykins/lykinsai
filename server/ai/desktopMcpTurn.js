/**
 * Desktop MCP turn wiring — the server side of MCP servers that run on the
 * user's own machine (Blender, Ableton, any stdio server).
 *
 * The Electron local MCP host (electron/mcp/localMcpHost.cjs) owns those
 * processes; the server never dials them. Each desktop turn ships a compact
 * `desktopMcpApps` summary, and this module is the single owner of what that
 * report does to a stream turn: sanitizing it, arming the client-executed
 * local_mcp_* registry tools, keeping tools on when the user names a
 * connected app, and the [DESKTOP_MCP_APPS] system guidance. Mirrors
 * buildWorkspaceTurn.js, which owns the same seams for Build workspace.
 */

import {
  DESKTOP_MCP_TOOL_NAMES,
  sanitizeDesktopMcpApps,
  mentionsDesktopMcpApp,
  messageWantsMcpConnect,
} from '../../mcp-tools/localTools.js';

/** Sanitized connected-apps report for this turn ([] outside the desktop). */
export function resolveDesktopMcpApps(body, { browserAsk = false } = {}) {
  const apps = browserAsk ? [] : sanitizeDesktopMcpApps(body?.desktopMcpApps);
  if (apps.length) {
    console.log(`🧩 Stream: desktop MCP apps connected: ${apps.map((a) => a.name).join(', ')}`);
  }
  return apps;
}

/**
 * Is a desktop MCP bridge present at all this turn? Distinct from the apps
 * report: at ZERO connections the report is empty, but the catalog/connect
 * tools still work — this flag is what lets "connect to blender" succeed on
 * a fresh install instead of needing a prior trip to Settings.
 */
export function resolveDesktopMcpAvailable(body, { browserAsk = false } = {}) {
  return body?.desktopMcpAvailable === true && !browserAsk;
}

/**
 * Does this message want to CONNECT a new app/tool? Arms catalog + connect
 * even when nothing is connected yet — the bootstrap the connected-app
 * matcher below cannot provide.
 */
export function desktopMcpConnectIntent(text) {
  return messageWantsMcpConnect(text);
}

/**
 * "Make a donut in Blender" has no file/web action keywords — the app NAME
 * is the intent. Used by the casual-tier and lean-path gates the same way
 * local file intent keeps Local Mode turns armed.
 */
export function desktopMcpIntent(text, apps) {
  return Array.isArray(apps) && apps.length > 0 && mentionsDesktopMcpApp(text, apps);
}

/** Append the client-executed registry tools to the turn's tool names. */
export function armDesktopMcpTools(toolNames) {
  const names = Array.isArray(toolNames) ? [...toolNames] : [];
  for (const n of DESKTOP_MCP_TOOL_NAMES) {
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

/**
 * File/terminal locals only — the desktop MCP registry tools share the
 * client-executed lane but must not trigger Local Mode guidance.
 */
export function withoutDesktopMcpTools(names) {
  return (Array.isArray(names) ? names : []).filter((n) => !DESKTOP_MCP_TOOL_NAMES.includes(n));
}

/**
 * System guidance for turns with connected desktop MCP apps. Without the app
 * list in the prompt the model has two registry schemas and no idea what
 * they reach; with it, "make me a donut in blender" resolves to search →
 * call instead of an apology.
 */
export function buildDesktopMcpGuidance(desktopMcpApps = [], { connectArmed = false } = {}) {
  const apps = Array.isArray(desktopMcpApps) ? desktopMcpApps : [];
  // The connect playbook: how the model bootstraps NEW connections from chat.
  // Emitted whenever the connect tools are armed, because both the zero-
  // connection case and "also hook up ableton" mid-session need it.
  const connectBlock = connectArmed
    ? '\n\n[DESKTOP_MCP_CONNECT]\n' +
      'You can connect new apps and tools on the user\'s computer, from chat, yourself. ' +
      'The flow: local_mcp_catalog to find the app (it reports what is already installed ' +
      'on this Mac, what is connected, and what each server needs) → local_mcp_connect ' +
      'to connect it — the user approves the exact command once. If connect returns ' +
      'env_required, ask the user for the listed API key(s), passing on the hint that ' +
      'says where to find each one, then connect again with env. If it returns setup ' +
      'steps (e.g. Blender\'s addon), walk the user through them conversationally, then ' +
      'retry. Connections persist across sessions. NEVER tell the user to go configure ' +
      'servers in Settings — you are the one who connects things. After connecting, do ' +
      'the actual task with local_mcp_search_tools + local_mcp_call_tool.'
    : '';
  if (!apps.length) return connectBlock;
  const lines = apps
    .map((app) => {
      const taste = (app.tools || []).slice(0, 6).join(', ');
      return `- ${app.name} (${app.toolCount} tools${taste ? `: ${taste}, …` : ''})`;
    })
    .join('\n');
  return (
    '\n\n[DESKTOP_MCP_APPS]\n' +
    'These MCP apps run LIVE on the user\'s own computer and you can operate them now:\n' +
    `${lines}\n` +
    'Use local_mcp_search_tools to find the right action, then local_mcp_call_tool to run ' +
    'it. Work iteratively: act, read the state back (scene info, screenshots, status ' +
    'tools), and continue until the result is what the user asked for. These are DESKTOP ' +
    'apps, not cloud connections — never tell the user you cannot reach their machine, ' +
    'and never invent tool names that a search did not return.\n' +
    'FINISH WHAT YOU START. A request like "model a car" means the COMPLETE thing — body, ' +
    'wheels, windows, lights, materials, sensible lighting and camera — not a blocked-out ' +
    'first pass. Before acting, list the parts the finished result needs; then work through ' +
    'ALL of them in many small tool calls, verifying visually after each meaningful change. ' +
    'You have a long tool budget on these turns — use it. Never end the turn by describing ' +
    'what you would do next: do it now. Ending with a partial build is a failure unless a ' +
    'tool error you cannot work around stops you — then report the exact error and exactly ' +
    'what remains. Verify the final result (screenshot or scene info) BEFORE you summarize.\n' +
    'MODEL THE REAL THING, NOT A MEMORY OF IT — the difference between "a car" and "a 911":\n' +
    '- If lykn_generate_3d_model is armed this turn, consider STARTING from it: a ' +
    'diffusion-generated GLB (from the user\'s reference photo when there is one) imports ' +
    'into the app and gives you real organic geometry to refine, instead of sculpting ' +
    'from primitives. Generation for shape; your tools for exactness.\n' +
    '- Dimensions first: state the object\'s true measurements before touching geometry (a ' +
    '911 is ~4.53 m long, 1.85 m wide, 1.30 m tall, 2.45 m wheelbase, wheels ~0.66 m) and ' +
    'build in real units to those numbers. Freestyled proportions are why models look wrong.\n' +
    '- TRACE, DON\'T GLANCE: put the reference INSIDE the workspace. In Blender, load the ' +
    'reference (and blueprints) as background image empties aligned to the matching ' +
    'orthographic views and model directly over them — a viewport screenshot then shows ' +
    'your silhouette sitting ON the photo, so mismatches are seen, not remembered. For ' +
    'vehicles and famous products, orthographic blueprint sheets exist online: fetch one ' +
    'FIRST. Modeling over a blueprint is how real car models are made.\n' +
    '- Judge proportions in ORTHOGRAPHIC side/front/top renders, not a flattering 3/4 shot: ' +
    'silhouette, roofline, wheel diameter vs body height, overhangs. Most "does not look ' +
    'like it" failures are proportion errors invisible from a beauty angle.\n' +
    '- A user-attached reference image is GROUND TRUTH. Render your model from the SAME ' +
    'angle as the reference, compare, name the 3 biggest mismatches, fix them, re-render. ' +
    'Repeat until the mismatches are details, not shapes. When you compare, composite the ' +
    'render and the reference into ONE side-by-side (or half-opacity overlay) image and ' +
    'look at THAT — two images far apart in a conversation hide errors a composite makes ' +
    'obvious. The reference is still in this conversation; look back at it between rounds.\n' +
    '- Measure the reference, not just the model: read ratios off the photo (wheelbase ÷ ' +
    'length, height ÷ width, wheel diameter ÷ body height) and verify your scene matches ' +
    'those numbers. Eyes judge shape; numbers judge proportion.\n' +
    '- Build curvature with curves: spline/bezier profiles, lofts, and subdivision surfaces ' +
    'over a low-poly control cage — never stacks of scaled primitives for organic shapes.\n' +
    '- EXACTNESS (CAD-grade work, parts with specified sizes): never eyeball a dimension. ' +
    'Set exact numeric transforms, then READ BACK the resulting measurements from the scene ' +
    'and confirm the numbers before moving on. A measurement check is a tool call, not a guess.\n' +
    'MATCH COLOR AND LIGHT BY MEASURING, NOT BY EYE — your vision is calibrated for ' +
    'judgment, not for exact values; scripts are for numbers:\n' +
    '- Sample the reference: read exact pixel RGB values programmatically (bpy image ' +
    'pixels / PIL / ImageMagick) from the body, trim, and glass regions — real hex values, ' +
    'converted sRGB→linear — and set material base colors to those numbers. Never guess ' +
    '"red"; there are thousands of reds and the photo tells you which one.\n' +
    '- Gradients on real surfaces are usually LIGHT, not paint: the sweep across a car ' +
    'body is reflection. Recreate it physically — metallic/clearcoat car-paint materials, ' +
    'an HDRI environment (PolyHaven HDRIs are free to download), filmic tonemapping — ' +
    'never paint reflections into a texture.\n' +
    '- Close the loop numerically: render from the matched angle, sample the SAME regions ' +
    'in your render, and compare RGB deltas against the reference; where ImageMagick is ' +
    'available, `magick compare -metric RMSE render.png ref.png null:` gives one score to ' +
    'drive down across iterations.\n' +
    '- Dimension-match through pixels: measure the same ratio in BOTH images from pixel ' +
    'coordinates (wheelbase-in-pixels ÷ length-in-pixels in the reference vs in your ' +
    'render) and adjust the model until the ratios agree.' +
    connectBlock
  );
}
