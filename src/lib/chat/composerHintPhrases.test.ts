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

test("build, imagine, and research stay on one sticky prompt", () => {
  assert.deepEqual(COMPOSER_HINT_PHRASES.build, ["What should LYKN build?"]);
  assert.deepEqual(COMPOSER_HINT_PHRASES.imagine, ["What do you want to create?"]);
  assert.deepEqual(COMPOSER_HINT_PHRASES.research, ["What should LYKN research?"]);
  for (const mode of ["build", "imagine", "research"] as const) {
    assert.equal(defaultComposerPlaceholder(mode), COMPOSER_HINT_PHRASES[mode][0]);
  }
});

test("unknown modes fall back to chat hints", () => {
  assert.equal(composerHintPhrases("nope"), COMPOSER_HINT_PHRASES.chat);
  assert.equal(defaultComposerPlaceholder(""), COMPOSER_HINT_PHRASES.chat[0]);
});
