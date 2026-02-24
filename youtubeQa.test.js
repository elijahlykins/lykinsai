import test from "node:test";
import assert from "node:assert/strict";
import {
  __clearYoutubeQaCachesForTests,
  __setYoutubeQaTestAdapters,
  answerVideoQuestion,
  getTranscriptPriority,
  localizeQuestion,
  retranscribeSegment,
} from "./youtubeQa.js";

function fakeResponse({ ok = true, status = 200, json, text }) {
  return {
    ok,
    status,
    async json() {
      return typeof json === "function" ? json() : json;
    },
    async text() {
      return typeof text === "function" ? text() : text;
    },
  };
}

function setupAdapters({ tracksXml = "", transcriptImpl, whisperImpl, description = "" } = {}) {
  __setYoutubeQaTestAdapters({
    fetchTranscriptImpl: transcriptImpl,
    whisperImpl,
    fetchImpl: async (url) => {
      const u = String(url);
      if (u.includes("video.google.com/timedtext?type=list")) {
        return fakeResponse({ text: tracksXml });
      }
      if (u.includes("youtube/v3/videos?part=snippet")) {
        return fakeResponse({
          json: {
            items: [
              {
                snippet: {
                  description,
                },
              },
            ],
          },
        });
      }
      return fakeResponse({ ok: false, status: 404, json: {} });
    },
  });
}

test("transcript priority prefers manual when manual captions exist", async () => {
  __clearYoutubeQaCachesForTests();
  setupAdapters({
    tracksXml: '<transcript_list><track lang_code="en" kind="" vss_id="en" /></transcript_list>',
    transcriptImpl: async () => [
      { start: 0, duration: 2, text: "Hello world" },
      { start: 2, duration: 2, text: "manual captions" },
    ],
  });
  const out = await getTranscriptPriority("video-manual", { youtubeApiKey: "x" });
  assert.equal(out.source, "manual");
  assert.ok(out.transcript.includes("Hello world"));
  assert.ok(out.segments.length >= 1);
});

test("transcript priority falls back to auto captions", async () => {
  __clearYoutubeQaCachesForTests();
  setupAdapters({
    tracksXml: '<transcript_list><track lang_code="en" kind="asr" vss_id="a.en" /></transcript_list>',
    transcriptImpl: async () => [{ start: 10, duration: 4, text: "auto captions text" }],
  });
  const out = await getTranscriptPriority("video-auto", { youtubeApiKey: "x" });
  assert.equal(out.source, "auto");
  assert.equal(out.segments[0].source, "auto");
});

test("transcript priority falls back to whisper full when captions missing", async () => {
  __clearYoutubeQaCachesForTests();
  setupAdapters({
    tracksXml: "<transcript_list></transcript_list>",
    transcriptImpl: async () => {
      throw new Error("no captions");
    },
    whisperImpl: async (payload) => {
      assert.equal(payload.startSec, undefined);
      return {
        strategy: "hosted_default",
        model: "whisper-x",
        segments: [{ startSec: 0, endSec: 6, text: "whispered full fallback", source: "whisper_full", confidence: 0.74 }],
      };
    },
  });
  const out = await getTranscriptPriority("video-whisper", { youtubeApiKey: "x" });
  assert.equal(out.source, "whisper_full");
  assert.ok(out.transcript.includes("whispered full fallback"));
});

test("specific questions trigger localization and segment retranscription", async () => {
  __clearYoutubeQaCachesForTests();
  let sawSegmentRetranscribe = false;
  setupAdapters({
    tracksXml: '<transcript_list><track lang_code="en" kind="asr" vss_id="a.en" /></transcript_list>',
    transcriptImpl: async () => [
      { start: 0, duration: 4, text: "intro content" },
      { start: 25, duration: 5, text: "the speaker says the launch date is april tenth" },
      { start: 40, duration: 5, text: "closing remarks" },
    ],
    whisperImpl: async (payload) => {
      if (payload.startSec != null) {
        sawSegmentRetranscribe = true;
        return {
          strategy: "hosted_default",
          model: "whisper-high",
          segments: [
            {
              startSec: payload.startSec,
              endSec: payload.endSec,
              text: "exact quote: the launch date is april 10 at noon",
              source: "whisper_segment",
              confidence: 0.86,
            },
          ],
        };
      }
      return null;
    },
  });

  const localized = await localizeQuestion("video-specific", "What exactly did they say the launch date was?");
  assert.ok(localized.segmentsTopK.length > 0);

  const refined = await retranscribeSegment("video-specific", 20, 35, "high");
  assert.ok(refined.text.includes("launch date"));

  const answer = await answerVideoQuestion("video-specific", "What exactly did they say the launch date was?");
  assert.equal(answer.grounded, true);
  assert.ok(Array.isArray(answer.evidence));
  assert.ok(answer.evidence.length > 0);
  assert.ok(sawSegmentRetranscribe);
});

test("description fallback still returns deeper grounded answer structure", async () => {
  __clearYoutubeQaCachesForTests();
  setupAdapters({
    tracksXml: "<transcript_list></transcript_list>",
    transcriptImpl: async () => {
      throw new Error("no captions");
    },
    whisperImpl: async () => null,
    description:
      "This lecture explains model evaluation tradeoffs.\nIt compares precision, recall, and F1.\nIt walks through threshold tuning.\nIt shows deployment monitoring strategies.\nIt ends with practical production checklist guidance.",
  });

  const out = await answerVideoQuestion("video-description", "Can you explain this video in depth?", { youtubeApiKey: "x" });
  assert.equal(out.grounded, true);
  assert.equal(out.transcriptSource, "description_fallback");
  assert.ok(out.answer.includes("Answer:"));
  assert.ok(out.answer.includes("Key grounded points:"));
  assert.ok(out.evidence.length >= 3);
});

test("low-confidence complex question retranscribes multiple top windows", async () => {
  __clearYoutubeQaCachesForTests();
  const retranscribeCalls = [];
  setupAdapters({
    tracksXml: '<transcript_list><track lang_code="en" kind="asr" vss_id="a.en" /></transcript_list>',
    transcriptImpl: async () => [
      { start: 0, duration: 4, text: "quick intro" },
      { start: 18, duration: 4, text: "mentions benchmarks briefly" },
      { start: 42, duration: 4, text: "mentions deployment concerns briefly" },
      { start: 68, duration: 4, text: "mentions monitoring quickly" },
    ],
    whisperImpl: async (payload) => {
      if (payload.startSec != null) {
        retranscribeCalls.push([payload.startSec, payload.endSec]);
        return {
          strategy: "hosted_default",
          model: "whisper-high",
          segments: [
            {
              startSec: payload.startSec,
              endSec: payload.endSec,
              text: `detailed retranscription for window ${payload.startSec}-${payload.endSec}`,
              source: "whisper_segment",
              confidence: 0.9,
            },
          ],
        };
      }
      return null;
    },
  });

  const out = await answerVideoQuestion(
    "video-low-confidence",
    "Give me a detailed explanation of benchmarks, deployment constraints, and monitoring strategy in this video."
  );
  assert.equal(out.grounded, true);
  assert.ok(retranscribeCalls.length >= 1);
  assert.ok(out.usedRetranscription);
  assert.ok(out.answer.includes("Key grounded points:"));
});
