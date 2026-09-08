import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generate3dModel, pick3dProviders } from './generate3dModel.js';

// ── Test doubles ─────────────────────────────────────────────────────────────

const noSleep = () => Promise.resolve();

// Resolve the underlying storage path from either URL shape the persist flow
// can produce: a branded file-proxy link (/f/<token>) when a proxy secret is
// available in the environment, or the raw signed URL fallback otherwise.
function storagePathFromUrl(url) {
  const proxyMatch = String(url).match(/\/f\/([^/?#]+)$/);
  if (proxyMatch) {
    const payloadB64 = proxyMatch[1].split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')).p;
  }
  return String(url).replace('https://signed.example/', '');
}

function fakeSupabase(uploads = []) {
  return {
    storage: {
      from() {
        return {
          upload(path, buffer, opts) {
            uploads.push({ path, bytes: buffer.length, contentType: opts.contentType });
            return Promise.resolve({ error: null });
          },
          createSignedUrl(path) {
            return Promise.resolve({ data: { signedUrl: `https://signed.example/${path}` } });
          },
        };
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: () => 'image/png' },
    arrayBuffer: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
  };
}

/** A scripted fetch: matches URL substrings to canned responses in order. */
function scriptedFetch(script) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    for (const [match, responses] of script) {
      if (String(url).includes(match)) {
        return responses.length > 1 ? responses.shift() : responses[0];
      }
    }
    throw new Error(`unscripted fetch: ${url}`);
  };
  impl.calls = calls;
  return impl;
}

// ── Provider selection ───────────────────────────────────────────────────────

test('pick3dProviders orders tripo first, keys gate membership', () => {
  assert.deepEqual(pick3dProviders({}), []);
  assert.deepEqual(
    pick3dProviders({ TRIPO_API_KEY: 't', MESHY_API_KEY: 'm' }).map((p) => p.id),
    ['tripo', 'meshy'],
  );
  assert.deepEqual(pick3dProviders({ MESHY_API_KEY: 'm' }).map((p) => p.id), ['meshy']);
});

// ── Full flow: Tripo submit → poll → download → persist ─────────────────────

test('tripo flow: submit, poll to success, persist GLB and preview', async () => {
  const uploads = [];
  const fetchImpl = scriptedFetch([
    ['generation/text-to-model', [jsonResponse({ code: 0, data: { task_id: 'task_1' } })]],
    [
      '/tasks/task_1',
      [
        jsonResponse({ code: 0, data: { status: 'running', progress: 40 } }),
        jsonResponse({
          code: 0,
          data: {
            status: 'success',
            type: 'text_to_model',
            output: {
              model_url: 'https://cdn.tripo.example/model.glb',
              rendered_image_url: 'https://cdn.tripo.example/preview.png',
            },
          },
        }),
      ],
    ],
    ['cdn.tripo.example/model.glb', [jsonResponse({})]],
    ['cdn.tripo.example/preview.png', [jsonResponse({})]],
  ]);

  const result = await generate3dModel({
    prompt: 'a silver 1970s Porsche 911',
    userId: 'user-1',
    supabaseAdmin: fakeSupabase(uploads),
    fetchImpl,
    sleepImpl: noSleep,
    env: { TRIPO_API_KEY: 'k' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'tripo');
  assert.equal(result.model_format, 'glb');
  // The GLB is re-hosted (provider URLs die in ~5 minutes) — but only as
  // EPHEMERAL transit under <userId>/ephemeral/, which the reconciler sweeps
  // after ~24h. The deliverable belongs on the user's machine, not in cloud
  // storage, so the link is never the raw provider URL and never durable.
  const modelPath = storagePathFromUrl(result.model_url);
  assert.match(modelPath, /^user-1\/ephemeral\//);
  assert.ok(modelPath.endsWith('.glb'));
  assert.ok(result.preview_image_url, 'preview render should persist too');
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].contentType, 'model/gltf-binary');
  // The agent-facing contract rides in the result.
  assert.match(result.usage_hint, /curl/);
  assert.match(result.usage_hint, /preview_image_url/);
});

test('image reference routes to image-to-model with the URL as input', async () => {
  const fetchImpl = scriptedFetch([
    ['generation/image-to-model', [jsonResponse({ code: 0, data: { task_id: 'task_2' } })]],
    [
      '/tasks/task_2',
      [
        jsonResponse({
          code: 0,
          data: { status: 'success', output: { model_url: 'https://cdn.tripo.example/m2.glb' } },
        }),
      ],
    ],
    ['cdn.tripo.example/m2.glb', [jsonResponse({})]],
  ]);
  const result = await generate3dModel({
    prompt: 'match this car',
    imageUrl: 'https://artifacts.example/f/ref-photo',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { TRIPO_API_KEY: 'k' },
  });
  assert.equal(result.ok, true);
  assert.ok(fetchImpl.calls.some((u) => u.includes('image-to-model')));
});

test('meshy fallback runs when tripo fails, needs an image', async () => {
  const fetchImpl = scriptedFetch([
    ['generation/image-to-model', [jsonResponse({ message: 'quota exceeded' }, 429)]],
    ['api.meshy.ai/openapi/v1/image-to-3d/task_m', [
      jsonResponse({
        status: 'SUCCEEDED',
        model_urls: { glb: 'https://assets.meshy.example/model.glb' },
        thumbnail_url: null,
      }),
    ]],
    ['api.meshy.ai/openapi/v1/image-to-3d', [jsonResponse({ result: 'task_m' })]],
    ['assets.meshy.example/model.glb', [jsonResponse({})]],
  ]);
  const result = await generate3dModel({
    imageUrl: 'https://artifacts.example/f/ref',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { TRIPO_API_KEY: 'k', MESHY_API_KEY: 'm' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'meshy');
});

test('meshy alone + text-only request fails with a clear reason', async () => {
  const result = await generate3dModel({
    prompt: 'a dragon',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl: scriptedFetch([]),
    sleepImpl: noSleep,
    env: { MESHY_API_KEY: 'm' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'meshy_needs_image_reference');
  // The hint tells the model what to do instead of silently giving up.
  assert.match(result.hint, /Blender|three\.js/);
});

// ── Guards ───────────────────────────────────────────────────────────────────

test('unconfigured, unauthenticated, and bad-input guards', async () => {
  const base = { userId: 'u', supabaseAdmin: fakeSupabase(), sleepImpl: noSleep };
  assert.equal(
    (await generate3dModel({ ...base, prompt: 'x', env: {} })).error,
    'model3d_generation_not_configured',
  );
  assert.equal(
    (await generate3dModel({ prompt: 'x', env: { TRIPO_API_KEY: 'k' } })).error,
    'unauthenticated',
  );
  assert.equal((await generate3dModel({ ...base, env: { TRIPO_API_KEY: 'k' } })).ok, false);
  assert.match(
    (await generate3dModel({ ...base, imageUrl: 'data:image/png;base64,x', env: { TRIPO_API_KEY: 'k' } })).error,
    /http\(s\) URL/,
  );
});

test('task failure reports the provider error, never fabricates a model', async () => {
  const fetchImpl = scriptedFetch([
    ['generation/text-to-model', [jsonResponse({ code: 0, data: { task_id: 'task_f' } })]],
    ['/tasks/task_f', [jsonResponse({ code: 0, data: { status: 'failed' } })]],
  ]);
  const result = await generate3dModel({
    prompt: 'x',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { TRIPO_API_KEY: 'k' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'tripo_task_failed');
});

test('insufficient balance short-circuits before any provider call', async () => {
  const fetchImpl = scriptedFetch([]);
  const result = await generate3dModel({
    prompt: 'x',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { TRIPO_API_KEY: 'k' },
    authorizeUsage: async () => ({ ok: false, error: 'insufficient_usage_balance' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'insufficient_usage_balance');
  assert.equal(result.add_funds, true);
  assert.equal(fetchImpl.calls.length, 0);
});
