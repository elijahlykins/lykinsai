import test from "node:test";
import assert from "node:assert/strict";
import { claimVoiceReplyPersist } from "@/lib/lyknChat/voiceReplyPersist";

test("duplicate transcript.done for one response persists once", () => {
  const seen = new Set<string>();
  assert.equal(claimVoiceReplyPersist(seen, "resp_1"), true);
  assert.equal(claimVoiceReplyPersist(seen, "resp_1"), false);
  assert.equal(claimVoiceReplyPersist(seen, "resp_2"), true);
});

test("empty response identity does not claim", () => {
  const seen = new Set<string>();
  assert.equal(claimVoiceReplyPersist(seen, ""), false);
  assert.equal(claimVoiceReplyPersist(seen, null), false);
});
