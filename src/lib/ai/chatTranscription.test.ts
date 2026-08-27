// Characterization tests for the transcription subsystem of the chat send
// pipeline. These lock CURRENT behavior — in-place attachment mutation,
// shared AbortSignal usage, YouTube caption→Whisper fallback ordering,
// status strings, and swallowed failures. They are not a spec of ideal
// behavior; if one fails after an intentional change, update it.
//
// Run: node --import ./scripts/test-alias-loader.mjs --test src/lib/ai/chatTranscription.test.ts

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  transcribeAttachments,
  fetchYouTubeGrounding,
} from "./chatTranscription";

/* ------------------------------------------------------------------ */
/*  fetch mock                                                          */
/* ------------------------------------------------------------------ */

type RecordedCall = { url: string; init: any };

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];
let responder: (url: string, init: any) => any = () => ({ ok: false });

function jsonResponse(body: any) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  calls = [];
  responder = () => ({ ok: false });
  (globalThis as any).fetch = async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const r = responder(String(url), init);
    if (r instanceof Error) throw r;
    return r;
  };
});

afterEach(() => {
  (globalThis as any).fetch = realFetch;
});

function statusRecorder() {
  const statuses: string[] = [];
  return { statuses, onStatus: (s: string) => statuses.push(s) };
}

/* ------------------------------------------------------------------ */
/*  transcribeAttachments                                               */
/* ------------------------------------------------------------------ */

test("transcribeAttachments: non-media attachment types trigger no network and no status", async () => {
  const { statuses, onStatus } = statusRecorder();
  const atts: any[] = [
    { type: "image", url: "data:image/png;base64,xx" },
    { type: "pdf", name: "doc.pdf" },
    { type: "link", url: "https://example.com" },
    { type: "document", name: "notes.txt" },
  ];
  await transcribeAttachments(atts as any, "https://api", false, new AbortController().signal, onStatus);
  assert.equal(calls.length, 0);
  assert.deepEqual(statuses, []);
  for (const a of atts) assert.equal(a.transcript, undefined);
});

test("transcribeAttachments: attachments with an existing transcript are skipped", async () => {
  const { onStatus } = statusRecorder();
  const att: any = { type: "youtube", videoId: "abc", transcript: "already here" };
  await transcribeAttachments([att] as any, "https://api", false, new AbortController().signal, onStatus);
  assert.equal(calls.length, 0);
  assert.equal(att.transcript, "already here");
});

test("transcribeAttachments: youtube captions success mutates the ORIGINAL attachment object in place", async () => {
  const { statuses, onStatus } = statusRecorder();
  const att: any = { type: "youtube", videoId: "vid123", name: "My Video" };
  const original = att;
  const atts = [att];
  responder = () => jsonResponse({ transcript: "hello world", source: "captions" });

  await transcribeAttachments(atts as any, "https://api", false, new AbortController().signal, onStatus);

  assert.strictEqual(atts[0], original); // same object identity — never cloned
  assert.equal(original.transcript, "hello world"); // in-place write
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("/api/youtube/transcript?id=vid123"));
  assert.deepEqual(statuses, ["Fetching video transcript..."]);
});

test("transcribeAttachments: brick action uses the 'Transcribing video...' status", async () => {
  const { statuses, onStatus } = statusRecorder();
  responder = () => jsonResponse({ transcript: "t", source: "captions" });
  await transcribeAttachments(
    [{ type: "youtube", videoId: "v1" }] as any,
    "https://api", true, new AbortController().signal, onStatus,
  );
  assert.deepEqual(statuses, ["Transcribing video..."]);
});

test("transcribeAttachments: description_fallback triggers retryWhisper=1 second call, retry transcript wins", async () => {
  const { statuses, onStatus } = statusRecorder();
  const att: any = { type: "youtube", videoId: "v2" };
  responder = (url) =>
    url.includes("retryWhisper=1")
      ? jsonResponse({ transcript: "spoken words", source: "whisper" })
      : jsonResponse({ transcript: "just a description", source: "description_fallback" });

  await transcribeAttachments([att] as any, "https://api", false, new AbortController().signal, onStatus);

  assert.equal(calls.length, 2);
  assert.ok(!calls[0].url.includes("retryWhisper"));
  assert.ok(calls[1].url.includes("retryWhisper=1"));
  assert.deepEqual(statuses, ["Fetching video transcript...", "No captions, transcribing audio..."]);
  assert.equal(att.transcript, "spoken words");
});

test("transcribeAttachments: when the whisper retry also falls back, transcript keeps the DESCRIPTION marker", async () => {
  const { onStatus } = statusRecorder();
  const att: any = { type: "youtube", videoId: "v3" };
  responder = () => jsonResponse({ transcript: "desc text", source: "description_fallback" });

  await transcribeAttachments([att] as any, "https://api", false, new AbortController().signal, onStatus);

  assert.equal(calls.length, 2);
  assert.equal(att.transcript, "[VIDEO DESCRIPTION — not a transcript of spoken audio]\ndesc text");
});

test("transcribeAttachments: the caller's AbortSignal is passed through unchanged to fetch", async () => {
  const controller = new AbortController();
  responder = () => jsonResponse({ transcript: "t", source: "captions" });
  await transcribeAttachments(
    [{ type: "youtube", videoId: "v4" }] as any,
    "https://api", false, controller.signal, () => {},
  );
  assert.equal(calls.length, 1);
  assert.strictEqual(calls[0].init.signal, controller.signal); // same signal object, no new controller
});

test("transcribeAttachments: an already-aborted signal skips youtube work entirely", async () => {
  const controller = new AbortController();
  controller.abort();
  const att: any = { type: "youtube", videoId: "v5" };
  await transcribeAttachments([att] as any, "https://api", false, controller.signal, () => {});
  assert.equal(calls.length, 0);
  assert.equal(att.transcript, undefined);
});

test("transcribeAttachments: network failure is swallowed and the send continues", async () => {
  const att: any = { type: "youtube", videoId: "v6" };
  responder = () => new Error("network down");
  await transcribeAttachments([att] as any, "https://api", false, new AbortController().signal, () => {});
  assert.equal(att.transcript, undefined); // no throw reached this line
});

test("transcribeAttachments: audio data-url attachment posts to whisper and mutates in place", async () => {
  const { statuses, onStatus } = statusRecorder();
  const b64 = Buffer.from("fake-audio-bytes").toString("base64");
  const att: any = { type: "audio", name: "memo.webm", url: `data:audio/webm;base64,${b64}` };
  responder = (url, init) => {
    assert.ok(url.endsWith("/api/whisper/transcribe"));
    assert.equal(init.method, "POST");
    assert.ok(init.body instanceof FormData);
    assert.ok(init.body.has("file"));
    return jsonResponse({ transcript: "voice memo text" });
  };

  await transcribeAttachments([att] as any, "https://api", false, new AbortController().signal, onStatus);

  assert.equal(calls.length, 1);
  assert.equal(att.transcript, "voice memo text");
  assert.deepEqual(statuses, ["Transcribing memo.webm..."]);
});

/* ------------------------------------------------------------------ */
/*  fetchYouTubeGrounding                                               */
/* ------------------------------------------------------------------ */

function makeGroundingArgs(overrides: any = {}) {
  const statuses: string[] = [];
  const abortController = new AbortController();
  const args: any = {
    apiBase: "https://api",
    needsFullTranscript: true,
    sentAttachments: [],
    abortController,
    transcriptCache: {},
    setChatStatusText: (s: string) => statuses.push(s),
    ...overrides,
  };
  return { args, statuses, abortController };
}

test("fetchYouTubeGrounding: captions success returns Full transcript grounding and writes the cache", async () => {
  const { args, statuses } = makeGroundingArgs({
    sentAttachments: [{ type: "youtube", videoId: "yt1", url: "https://youtu.be/yt1", name: "Talk" }],
  });
  responder = () => jsonResponse({ transcript: "the spoken content", source: "captions", segments: [] });

  const res = await fetchYouTubeGrounding(args);

  assert.equal(res.youtubeTranscriptSource, "captions");
  assert.ok(res.youtubeGrounding.includes("Video: Talk\nFull transcript:\nthe spoken content"));
  assert.equal(args.transcriptCache["yt1"].transcript, "the spoken content");
  assert.deepEqual(statuses, ["Fetching video transcript...", "Transcript ready, generating response..."]);
  assert.equal(calls.length, 1);
});

test("fetchYouTubeGrounding: description_fallback retries with retryWhisper=1 before settling on description", async () => {
  const { args, statuses } = makeGroundingArgs({
    sentAttachments: [{ type: "youtube", videoId: "yt2", url: "u2", name: "Vid" }],
  });
  responder = (url) =>
    url.includes("retryWhisper=1")
      ? { ok: false }
      : jsonResponse({ transcript: "only the description", source: "description_fallback", whisperAttempted: true });

  const res = await fetchYouTubeGrounding(args);

  assert.equal(calls.length, 2);
  assert.ok(!calls[0].url.includes("retryWhisper"));
  assert.ok(calls[1].url.includes("retryWhisper=1"));
  assert.equal(res.youtubeTranscriptSource, "description_fallback");
  assert.ok(res.youtubeGrounding.includes("NOT a transcript of spoken audio"));
  assert.deepEqual(statuses, [
    "Fetching video transcript...",
    "No captions found, transcribing video audio...",
    "Transcription failed, only description available...",
  ]);
});

test("fetchYouTubeGrounding: every fetch uses the SAME send-level signal (no new controller)", async () => {
  const { args, abortController } = makeGroundingArgs({
    sentAttachments: [{ type: "youtube", videoId: "yt3", url: "u3", name: "V" }],
  });
  responder = () => jsonResponse({ transcript: "d", source: "description_fallback" });

  await fetchYouTubeGrounding(args);

  assert.ok(calls.length >= 2);
  for (const c of calls) assert.strictEqual(c.init.signal, abortController.signal);
});

test("fetchYouTubeGrounding: no videos and no full-transcript need means no fetch and empty grounding", async () => {
  const { args, statuses } = makeGroundingArgs({ needsFullTranscript: false });
  const res = await fetchYouTubeGrounding(args);
  assert.equal(calls.length, 0);
  assert.equal(res.youtubeGrounding, "");
  assert.equal(res.youtubeTranscriptSource, "");
  assert.deepEqual(statuses, []);
});
