import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractImagineConversationBrief,
  imagineConversationBriefForPrompt,
  isBareImagineAction,
  needsImagineConversation,
  resolveImagineGenerationPrompt,
} from "./imagineConversationPrompt.ts";

const PLAN = [
  {
    content: "Let's brainstorm a poster. Fox astronaut on Mars, golden hour, vintage NASA typeface, visor reflecting Earth.",
    aiResponse:
      "Here's the plan: a cinematic landscape poster. The fox wears a worn NASA suit at the rim of a rust-red crater. Golden-hour light rakes across the helmet. The visor is a sharp Earth reflection. Title set in a 1960s NASA gothic, cream on rust.",
  },
];

describe("needsImagineConversation", () => {
  it("treats go / generate-it sends as needing the prior plan", () => {
    for (const ask of [
      "generate it",
      "make it",
      "go",
      "do it",
      "create the image",
      "generate an image",
      "yes",
      "let's go",
    ]) {
      assert.equal(needsImagineConversation(ask), true, ask);
      assert.equal(isBareImagineAction(ask), true, ask);
    }
  });

  it("folds short definite and deictic follow-ups into the plan", () => {
    assert.equal(needsImagineConversation("the poster"), true);
    assert.equal(needsImagineConversation("make it darker"), true);
    assert.equal(needsImagineConversation("that but at night"), true);
    assert.equal(needsImagineConversation("same idea but rain"), true);
  });

  it("leaves a self-contained scene alone", () => {
    assert.equal(
      needsImagineConversation(
        "a photorealistic red bicycle leaning against a wet brick wall in the rain",
      ),
      false,
    );
    assert.equal(
      needsImagineConversation(
        "a cinematic poster of a fox astronaut on mars at golden hour with vintage NASA lettering",
      ),
      false,
    );
  });
});

describe("extractImagineConversationBrief", () => {
  it("keeps the Chat brainstorm and drops Imagine / switch turns", () => {
    const brief = extractImagineConversationBrief([
      ...PLAN,
      {
        content: "generate an image of a dog",
        aiResponse:
          "Image generation lives in Imagine. Switch to **Imagine** using the pills at the top of the page and send it again.",
      },
      {
        content: "generate it",
        aiResponse: "Generated 4 images.",
        imagine: { aspect: "1:1", kind: "generate" },
        aiImages: [{ url: "https://img/1.png" }],
      },
    ]);
    assert.match(brief, /Fox astronaut on Mars/);
    assert.match(brief, /1960s NASA gothic/);
    assert.doesNotMatch(brief, /Generated 4 images/);
    assert.doesNotMatch(brief, /Switch to \*\*Imagine\*\*/);
    assert.doesNotMatch(brief, /generate an image of a dog/);
  });

  it("returns empty when the thread has no planning turns", () => {
    assert.equal(
      extractImagineConversationBrief([
        { kind: "load-in-greeting", aiResponse: "Hi, I'm LYKN." },
      ]),
      "",
    );
  });
});

describe("imagineConversationBriefForPrompt", () => {
  it("attaches the plan only when the typed prompt is underspecified", () => {
    const brief = imagineConversationBriefForPrompt("generate it", PLAN);
    assert.match(brief, /Fox astronaut/);
    assert.equal(
      imagineConversationBriefForPrompt(
        "a photorealistic red bicycle leaning against a wet brick wall in the rain",
        PLAN,
      ),
      "",
    );
  });
});

describe("resolveImagineGenerationPrompt", () => {
  it("leads with the planned image when the user just says generate it", () => {
    const prompt = resolveImagineGenerationPrompt({
      text: "generate it",
      conversationBrief: extractImagineConversationBrief(PLAN),
    });
    assert.match(prompt, /Generate the image described above/);
    assert.match(prompt, /Fox astronaut/);
    assert.match(prompt, /1960s NASA gothic/);
    assert.ok(!/^generate it/i.test(prompt), "the bare send must not be the whole prompt");
  });

  it("keeps a specific follow-up in front and still grounds it in the plan", () => {
    const prompt = resolveImagineGenerationPrompt({
      text: "that but at night",
      conversationBrief: extractImagineConversationBrief(PLAN),
    });
    assert.ok(prompt.startsWith("that but at night"));
    assert.match(prompt, /Planned image from this conversation/);
    assert.match(prompt, /fox wears a worn NASA suit/i);
  });

  it("leaves a standalone scene as the whole prompt", () => {
    const prompt = resolveImagineGenerationPrompt({
      text: "a photorealistic red bicycle leaning against a wet brick wall in the rain",
    });
    assert.equal(
      prompt,
      "a photorealistic red bicycle leaning against a wet brick wall in the rain",
    );
  });
});
