import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPOSER_HINT_PHRASES,
  composerHintPhrases,
  defaultComposerPlaceholder,
} from "./composerHintPhrases";

test("chat hints teach slash folder access and keep Ask me anything", () => {
  const chat = composerHintPhrases("chat");
  assert.ok(chat.includes("Ask me anything..."));
  assert.ok(chat.some((line) => line.includes("/") && /folder/i.test(line)));
  assert.ok(chat.length >= 4);
});

test("each studio mode rotates through more than one phrase", () => {
  for (const mode of ["chat", "build", "imagine", "research"] as const) {
    const phrases = COMPOSER_HINT_PHRASES[mode];
    assert.ok(phrases.length >= 2, `${mode} should rotate`);
    assert.equal(defaultComposerPlaceholder(mode), phrases[0]);
  }
});

test("unknown modes fall back to chat hints", () => {
  assert.equal(composerHintPhrases("nope"), COMPOSER_HINT_PHRASES.chat);
  assert.equal(defaultComposerPlaceholder(""), COMPOSER_HINT_PHRASES.chat[0]);
});
