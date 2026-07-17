// ============================================================================
// renderVideo — model-written Remotion compositions rendered to real .mp4.
//
// The model writes a single-file Remotion composition (same frame-based API
// as the repo's own marketing videos: useCurrentFrame / interpolate / spring /
// Sequence / AbsoluteFill / Img). We write it to a temp workspace with a
// generated entry that registers ONE composition sized from the tool args,
// bundle it with @remotion/bundler (webpack — real npm imports of `remotion`
// and `react` resolve for real, no import rewriting needed), render it with
// @remotion/renderer (headless Chrome + bundled ffmpeg), persist the mp4 to
// capability storage, and hand back the branded file_url.
//
// Renders are CPU-heavy and take O(duration): caps below keep a single call
// bounded (≤30s of video, ≤1080p) and a global in-process lock serializes
// renders so two chat turns can't saturate the box.
// ============================================================================

import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { persistCapabilityArtifact } from '../capabilityStorage.js';

const require = createRequire(import.meta.url);

const MAX_CODE_LEN = 60000;
const MAX_FRAMES = 900; // 30s at 30fps
const MIN_FRAMES = 15;
const MAX_DIM = 1920;
const MIN_DIM = 64;
const ALLOWED_FPS = new Set([24, 30, 60]);
const RENDER_TIMEOUT_MS = 4 * 60 * 1000;

// Serialize renders — bundling + headless Chrome per render is heavy enough
// that concurrent renders on one box help nobody.
let renderChain = Promise.resolve();

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function slugify(title) {
  const base = String(title || 'video')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'video';
}

/** Entry file registering the model's component as the single composition. */
function entrySource({ durationInFrames, fps, width, height }) {
  return [
    "import React from 'react';",
    "import { registerRoot, Composition } from 'remotion';",
    "import Main from './composition';",
    '',
    'const Root = () =>',
    '  React.createElement(Composition, {',
    "    id: 'Main',",
    '    component: Main,',
    `    durationInFrames: ${durationInFrames},`,
    `    fps: ${fps},`,
    `    width: ${width},`,
    `    height: ${height},`,
    '  });',
    '',
    'registerRoot(Root);',
    '',
  ].join('\n');
}

/** Exported for scripts/test-render-video.mjs — not part of the tool surface. */
export async function renderOnce({ code, durationInFrames, fps, width, height, onProgress }) {
  // Lazy imports: @remotion/bundler drags in webpack — don't pay that on
  // server boot, only when a video render actually runs.
  const { bundle } = require('@remotion/bundler');
  const { renderMedia, selectComposition } = require('@remotion/renderer');

  const workDir = await mkdtemp(path.join(tmpdir(), 'lykn-video-'));
  let bundleDir = null;
  try {
    await writeFile(path.join(workDir, 'composition.tsx'), code, 'utf8');
    await writeFile(
      path.join(workDir, 'index.ts'),
      entrySource({ durationInFrames, fps, width, height }),
      'utf8',
    );

    const serveUrl = await bundle({
      entryPoint: path.join(workDir, 'index.ts'),
      // Remotion's default webpack config handles TS/JSX out of the box.
      onProgress: () => {},
    });
    bundleDir = serveUrl;

    const composition = await selectComposition({ serveUrl, id: 'Main' });

    const outputLocation = path.join(workDir, 'out.mp4');
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation,
      // Matches remotion.config.ts — WebGL-less headless needs ANGLE for
      // anything that touches a GL context; harmless otherwise.
      chromiumOptions: { gl: 'angle' },
      timeoutInMilliseconds: 60000,
      onProgress: ({ progress }) => {
        if (typeof onProgress === 'function') onProgress(progress);
      },
    });

    const buffer = await readFile(outputLocation);
    return { ok: true, buffer };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Render a model-written Remotion composition to mp4 and persist it.
 * Args: { title, code, duration_in_frames?, fps?, width?, height? }
 */
export async function renderVideo(args = {}, ctx = {}) {
  const title = String(args.title || '').trim().slice(0, 160) || 'Animation';
  const code = String(args.code ?? '');

  if (!code.trim()) {
    return {
      ok: false,
      error: 'code_required',
      hint:
        'Write the Remotion composition yourself and pass its full source in `code` — one file, ' +
        '`export default` a React component that reads useCurrentFrame() from the `remotion` package.',
    };
  }
  if (code.length > MAX_CODE_LEN) {
    return { ok: false, error: 'code_too_long', max_chars: MAX_CODE_LEN };
  }
  if (!/export\s+default/.test(code)) {
    return {
      ok: false,
      error: 'no_default_export',
      hint: 'The composition file must `export default` the component to render.',
    };
  }
  if (/registerRoot|<\s*Composition[\s>]/.test(code)) {
    return {
      ok: false,
      error: 'no_register_root',
      hint:
        'Do NOT call registerRoot() or render <Composition> — pass ONLY the component itself; ' +
        'the server registers it with your duration_in_frames/fps/width/height args.',
    };
  }
  if (!ctx.supabaseAdmin || !ctx.userId) {
    return { ok: false, error: 'unauthenticated' };
  }

  const fpsArg = Number.parseInt(args.fps, 10);
  const fps = ALLOWED_FPS.has(fpsArg) ? fpsArg : 30;
  const durationInFrames = clampInt(args.duration_in_frames, MIN_FRAMES, MAX_FRAMES, fps * 5);
  const width = clampInt(args.width, MIN_DIM, MAX_DIM, 1280);
  const height = clampInt(args.height, MIN_DIM, MAX_DIM, 720);

  // Queue behind any in-flight render, then hard-cap the whole thing.
  const job = renderChain.then(() =>
    Promise.race([
      renderOnce({ code, durationInFrames, fps, width, height, onProgress: ctx.onRenderProgress }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('render_timeout')), RENDER_TIMEOUT_MS),
      ),
    ]),
  );
  renderChain = job.catch(() => {});

  let rendered;
  const startedAt = Date.now();
  try {
    rendered = await job;
  } catch (err) {
    const msg = err?.message || 'render_failed';
    console.error('🎬 renderVideo failed:', msg);
    return {
      ok: false,
      error: msg.slice(0, 600),
      hint:
        'The composition failed to bundle or render. Fix the code and call the tool again — common causes: ' +
        'imports outside `remotion`/`react`, runtime errors at frame 0, or an <Img> URL that is not reachable.',
    };
  }

  const base = slugify(title);
  const stored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
    buffer: rendered.buffer,
    filename: `${base}.mp4`,
    mimeType: 'video/mp4',
    category: 'video',
  });
  if (!stored.ok) return { ok: false, error: stored.error || 'video_persist_failed' };

  // The raw composition source rides along as a second download so the user
  // can drop it into their own Remotion project (this repo's remotion/ dir).
  let codeUrl = null;
  const codeStored = await persistCapabilityArtifact(ctx.supabaseAdmin, ctx.userId, {
    buffer: Buffer.from(code, 'utf8'),
    filename: `${base}.tsx`,
    mimeType: 'text/plain; charset=utf-8',
    category: 'video',
  });
  if (codeStored.ok) codeUrl = codeStored.file_url;

  if (typeof ctx.logUsage === 'function') {
    try {
      await ctx.logUsage({
        userId: ctx.userId,
        actionType: 'video_render',
        model: 'remotion',
        provider: 'local',
        inputTokens: Math.ceil(code.length / 4),
        outputTokens: 0,
        metadata: {
          tool: 'lykn_render_video',
          storage_path: stored.storage_path,
          duration_in_frames: durationInFrames,
          fps,
          width,
          height,
          render_ms: Date.now() - startedAt,
        },
      });
    } catch {
      /* telemetry non-critical */
    }
  }

  return {
    ok: true,
    kind: 'video',
    title,
    filename: stored.filename,
    file_url: stored.file_url,
    storage_path: stored.storage_path,
    bytes: stored.bytes,
    duration_in_frames: durationInFrames,
    fps,
    width,
    height,
    duration_sec: Math.round((durationInFrames / fps) * 10) / 10,
    render_ms: Date.now() - startedAt,
    download_links: [
      { format: 'mp4', url: stored.file_url, filename: stored.filename },
      ...(codeUrl ? [{ format: 'tsx', url: codeUrl, filename: `${base}.tsx` }] : []),
    ],
    usage_hint:
      'The video is ALREADY shown to the user as an inline playable card. Reply with a 1-2 sentence ' +
      'summary — do NOT paste the code or any URL into the chat.',
  };
}
