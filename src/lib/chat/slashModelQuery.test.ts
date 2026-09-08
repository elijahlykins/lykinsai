import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsStudioModelPickerEvent,
  findSlashModelToken,
  looksLikeModelShortcut,
  modelLabLogoSlug,
  modelLabLogoUrl,
  rankSlashModelOptions,
  type SlashModelOption,
} from "./slashModelQuery";

test("findSlashModelToken treats /model as the picker command", () => {
  assert.deepEqual(findSlashModelToken("/model", 6), {
    start: 0,
    end: 6,
    raw: "/model",
    query: "",
    kind: "picker",
  });
  assert.deepEqual(findSlashModelToken("/model ", 7), {
    start: 0,
    end: 7,
    raw: "/model ",
    query: "",
    kind: "picker",
  });
  assert.equal(findSlashModelToken("/modeling", 9), null);
});

test("findSlashModelToken matches /gpt-5 style model names", () => {
  assert.deepEqual(findSlashModelToken("/gpt-5", 6), {
    start: 0,
    end: 6,
    raw: "/gpt-5",
    query: "gpt-5",
    kind: "search",
  });
  assert.deepEqual(findSlashModelToken("use /claude", 11), {
    start: 4,
    end: 11,
    raw: "/claude",
    query: "claude",
    kind: "search",
  });
  assert.equal(findSlashModelToken("/Documents", 10), null);
  assert.equal(findSlashModelToken("/Users/lykn", 11), null);
});

test("acceptsStudioModelPickerEvent only opens the Home bar copy on Home", () => {
  const closestOf = (hits: string[]) => ({
    closest: (selector: string) => (hits.includes(selector) ? {} : null),
  });
  assert.equal(acceptsStudioModelPickerEvent(closestOf([".lykn-home-bar-model"])), true);
  assert.equal(
    acceptsStudioModelPickerEvent(closestOf([".lykn-home-bar-model", ".lykn-home-chat-host"])),
    true,
  );
  assert.equal(acceptsStudioModelPickerEvent(closestOf([".lykn-home-chat-host"])), false);
  assert.equal(acceptsStudioModelPickerEvent(closestOf([])), true);
  assert.equal(acceptsStudioModelPickerEvent(null), false);
});

test("looksLikeModelShortcut ignores ordinary folder names", () => {
  assert.equal(looksLikeModelShortcut("gpt-5"), true);
  assert.equal(looksLikeModelShortcut("claude"), true);
  assert.equal(looksLikeModelShortcut("Documents"), false);
  assert.equal(looksLikeModelShortcut("model"), false);
});

test("modelLabLogoSlug uses the lab mark for gpt / claude / grok", () => {
  assert.equal(modelLabLogoSlug({ value: "gpt-5.6-sol", label: "GPT-5.6 Sol" }), "openai");
  assert.equal(modelLabLogoUrl({ value: "gpt-5" }), "https://models.dev/logos/openai.svg");
  assert.equal(modelLabLogoSlug({ value: "claude-opus-5", hint: "Anthropic" }), "anthropic");
  assert.equal(modelLabLogoSlug({ value: "grok-4.6", group: "xAI" }), "xai");
  assert.equal(modelLabLogoSlug({ value: "gemini-3.1-pro-preview" }), "google");
  assert.equal(modelLabLogoSlug({ value: "openai/gpt-5" }), "openai");
  assert.equal(modelLabLogoSlug({ value: "lykn", label: "LYKN" }), "");
});

test("rankSlashModelOptions puts the closest model first", () => {
  const options: SlashModelOption[] = [
    { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "OpenAI", group: "Top models" },
    { value: "lykn", label: "LYKN", hint: "", group: "" },
    { value: "grok-4.6", label: "Grok 4.6", hint: "xAI", group: "Top models" },
    { value: "grok-4.5", label: "Grok 4.5", hint: "", group: "xAI" },
    { value: "claude-opus-5", label: "Claude Opus 5", hint: "Flagship", group: "Anthropic", locked: true },
  ];
  assert.deepEqual(
    rankSlashModelOptions(options, "LYKN").map((o) => o.value),
    ["lykn"],
  );
  assert.deepEqual(
    rankSlashModelOptions(options, "gpt-5").map((o) => o.value),
    ["gpt-5.6-sol"],
  );
  assert.deepEqual(
    rankSlashModelOptions(options, "grok").map((o) => o.value),
    ["grok-4.5", "grok-4.6"],
  );
});
