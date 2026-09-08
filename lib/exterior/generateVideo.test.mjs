import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateChatVideo,
  pickVideoProviders,
  videoModelForProvider,
  DEFAULT_OPENROUTER_VIDEO_MODEL,
  DEFAULT_VEO_MODEL,
} from './generateVideo.js';

const noSleep = () => Promise.resolve();

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

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    headers: { get: (h) => (h === 'content-type' ? contentType : null) },
    arrayBuffer: () => Promise.resolve(new Uint8Array([9, 9, 9]).buffer),
  };
}

function scriptedFetch(script) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
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

test('OpenRouter is the primary video provider, direct Veo the fallback', () => {
  assert.deepEqual(pickVideoProviders({}), []);
  assert.deepEqual(
    pickVideoProviders({ OPENROUTER_API_KEY: 'or', GOOGLE_API_KEY: 'g' }).map((p) => p.id),
    ['openrouter', 'gemini'],
  );
  assert.deepEqual(pickVideoProviders({ GOOGLE_API_KEY: 'g' }).map((p) => p.id), ['gemini']);
});

test('model routing: slugs with a vendor prefix ride OpenRouter, bare names ride Gemini', () => {
  // No request → per-provider defaults (env-overridable).
  assert.equal(videoModelForProvider('openrouter', '', {}), DEFAULT_OPENROUTER_VIDEO_MODEL);
  assert.equal(videoModelForProvider('gemini', '', {}), DEFAULT_VEO_MODEL);
  assert.equal(
    videoModelForProvider('openrouter', '', { OPENROUTER_VIDEO_MODEL: 'kwaivgi/kling-v3.0-pro' }),
    'kwaivgi/kling-v3.0-pro',
  );
  // An explicit OpenRouter slug is honored; the Gemini fallback ignores it
  // (a slug is not a Veo endpoint name) and keeps its own default.
  assert.equal(
    videoModelForProvider('openrouter', 'bytedance/seedance-2.0', {}),
    'bytedance/seedance-2.0',
  );
  assert.equal(videoModelForProvider('gemini', 'bytedance/seedance-2.0', {}), DEFAULT_VEO_MODEL);
});

// ── OpenRouter flow ──────────────────────────────────────────────────────────

test('openrouter flow: submit job → poll → download with bearer → persist mp4', async () => {
  const uploads = [];
  const fetchImpl = scriptedFetch([
    [
      'api/v1/videos/job1',
      [
        jsonResponse({ id: 'job1', status: 'in_progress' }),
        jsonResponse({
          id: 'job1',
          status: 'completed',
          unsigned_urls: ['https://openrouter.ai/api/v1/videos/job1/content?index=0'],
          usage: { cost: 1.18 },
        }),
      ],
    ],
    ['api/v1/videos', [jsonResponse({ id: 'job1', polling_url: 'https://openrouter.ai/api/v1/videos/job1', status: 'pending' }, { status: 202 })]],
  ]);
  // The content URL also matches 'api/v1/videos/job1' — third scripted hit
  // returns a JSON-shaped response whose arrayBuffer we still accept as bytes.
  fetchImpl.calls; // (download reuses the polling matcher's last response)

  const result = await generateChatVideo({
    prompt: 'a drone shot over a coastal cliff at golden hour',
    aspectRatio: '16:9',
    durationSeconds: 8,
    userId: 'user-1',
    supabaseAdmin: fakeSupabase(uploads),
    fetchImpl,
    sleepImpl: noSleep,
    env: { OPENROUTER_API_KEY: 'or-key' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.model, DEFAULT_OPENROUTER_VIDEO_MODEL);
  assert.equal(result.provider_cost_usd, 1.18);
  assert.match(result.video_url, /^https:\/\/signed\.example\/user-1\/generated\/.*\.mp4$/);
  assert.equal(uploads[0].contentType, 'video/mp4');

  // Submit carried the standardized OpenRouter parameters.
  const submit = fetchImpl.calls.find(
    (c) => c.url === 'https://openrouter.ai/api/v1/videos' && c.opts.method === 'POST',
  );
  const body = JSON.parse(submit.opts.body);
  assert.equal(body.model, DEFAULT_OPENROUTER_VIDEO_MODEL);
  assert.equal(body.aspect_ratio, '16:9');
  assert.equal(body.duration, 8);
  // Every OpenRouter call (poll + download included) authenticated with the key.
  const authed = fetchImpl.calls.filter((c) => c.opts.headers?.Authorization === 'Bearer or-key');
  assert.ok(authed.length >= 3);
});

test('reference image rides as an OpenRouter first_frame data URL', async () => {
  const fetchImpl = scriptedFetch([
    [
      'api/v1/videos/job2',
      [
        jsonResponse({
          id: 'job2',
          status: 'completed',
          unsigned_urls: ['https://openrouter.ai/api/v1/videos/job2/content?index=0'],
        }),
      ],
    ],
    ['api/v1/videos', [jsonResponse({ id: 'job2', polling_url: 'https://openrouter.ai/api/v1/videos/job2', status: 'pending' }, { status: 202 })]],
  ]);
  const result = await generateChatVideo({
    prompt: 'bring this scene to life, slow push-in',
    referenceImage: 'data:image/png;base64,QUJD',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { OPENROUTER_API_KEY: 'or-key' },
  });
  assert.equal(result.ok, true);
  const submit = fetchImpl.calls.find(
    (c) => c.url === 'https://openrouter.ai/api/v1/videos' && c.opts.method === 'POST',
  );
  const body = JSON.parse(submit.opts.body);
  assert.equal(body.frame_images[0].frame_type, 'first_frame');
  assert.equal(body.frame_images[0].image_url.url, 'data:image/png;base64,QUJD');
});

// ── Gemini fallback ──────────────────────────────────────────────────────────

test('gemini fallback runs when OpenRouter fails, with its own model name', async () => {
  const fetchImpl = scriptedFetch([
    ['api/v1/videos', [jsonResponse({ error: 'no capacity' }, { status: 503 })]],
    [':predictLongRunning', [jsonResponse({ name: 'models/veo/operations/op1' })]],
    [
      'operations/op1',
      [
        jsonResponse({
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [{ video: { uri: 'https://g.example/files/f1:download' } }],
            },
          },
        }),
      ],
    ],
    ['files/f1:download', [jsonResponse({}, { contentType: 'video/mp4' })]],
  ]);
  const result = await generateChatVideo({
    prompt: 'x',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { OPENROUTER_API_KEY: 'or-key', GOOGLE_API_KEY: 'g-key' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'google');
  assert.equal(result.model, DEFAULT_VEO_MODEL);
  // Gemini download authenticated with the Google header, not the Bearer key.
  const dl = fetchImpl.calls.find((c) => c.url.includes('files/f1:download'));
  assert.equal(dl.opts.headers['x-goog-api-key'], 'g-key');
});

test('gemini submit carries the reference as inlineData first frame', async () => {
  const fetchImpl = scriptedFetch([
    [':predictLongRunning', [jsonResponse({ name: 'models/veo/operations/op2' })]],
    [
      'operations/op2',
      [
        jsonResponse({
          done: true,
          response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://g.example/files/f2' } }] } },
        }),
      ],
    ],
    ['files/f2', [jsonResponse({}, { contentType: 'video/mp4' })]],
  ]);
  const result = await generateChatVideo({
    prompt: 'animate',
    referenceImage: 'data:image/png;base64,QUJD',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { GOOGLE_API_KEY: 'g-key' },
  });
  assert.equal(result.ok, true);
  const submit = fetchImpl.calls.find((c) => c.url.includes(':predictLongRunning'));
  const body = JSON.parse(submit.opts.body);
  assert.equal(body.instances[0].image.inlineData.data, 'QUJD');
});

// ── Local delivery (deliverBytes) ────────────────────────────────────────────

test('deliverBytes returns base64 and never touches cloud storage', async () => {
  const uploads = [];
  const fetchImpl = scriptedFetch([
    [
      'api/v1/videos/job4',
      [
        jsonResponse({
          id: 'job4',
          status: 'completed',
          unsigned_urls: ['https://openrouter.ai/api/v1/videos/job4/content?index=0'],
        }),
      ],
    ],
    ['api/v1/videos', [jsonResponse({ id: 'job4', polling_url: 'https://openrouter.ai/api/v1/videos/job4', status: 'pending' }, { status: 202 })]],
  ]);
  const result = await generateChatVideo({
    prompt: 'a clip that stays on the user machine',
    deliverBytes: true,
    userId: 'user-1',
    supabaseAdmin: fakeSupabase(uploads),
    fetchImpl,
    sleepImpl: noSleep,
    env: { OPENROUTER_API_KEY: 'or-key' },
  });
  assert.equal(result.ok, true);
  // The MP4 rides back as base64 for the local vault store — no upload, no
  // signed URL, no storage path.
  assert.equal(result.video_base64, Buffer.from([9, 9, 9]).toString('base64'));
  assert.equal(result.video_url, null);
  assert.equal(result.storage_path, null);
  assert.equal(uploads.length, 0);
});

// ── Failure honesty and guards ───────────────────────────────────────────────

test('terminal job failure and missing config are honest failures', async () => {
  const failFetch = scriptedFetch([
    [
      'api/v1/videos/job3',
      [jsonResponse({ id: 'job3', status: 'failed', error: 'Content policy violation' })],
    ],
    ['api/v1/videos', [jsonResponse({ id: 'job3', polling_url: 'https://openrouter.ai/api/v1/videos/job3', status: 'pending' }, { status: 202 })]],
  ]);
  const failed = await generateChatVideo({
    prompt: 'x',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl: failFetch,
    sleepImpl: noSleep,
    env: { OPENROUTER_API_KEY: 'or-key' },
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'Content policy violation');
  assert.match(failed.hint, /never pretend/);

  const unconfigured = await generateChatVideo({
    prompt: 'x',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl: scriptedFetch([]),
    sleepImpl: noSleep,
    env: {},
  });
  assert.equal(unconfigured.error, 'video_generation_not_configured');
});

test('insufficient balance short-circuits before any provider call', async () => {
  const fetchImpl = scriptedFetch([]);
  const result = await generateChatVideo({
    prompt: 'x',
    userId: 'u',
    supabaseAdmin: fakeSupabase(),
    fetchImpl,
    sleepImpl: noSleep,
    env: { OPENROUTER_API_KEY: 'or-key' },
    authorizeUsage: async () => ({ ok: false, error: 'insufficient_usage_balance' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.add_funds, true);
  assert.equal(fetchImpl.calls.length, 0);
});
