import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectImageAsk,
  detectStudioModeRedirect,
  imagineSwitchNotice,
} from "./studioModeIntent.ts";

describe("detectImageAsk", () => {
  it("detects typed image commissions", () => {
    assert.equal(detectImageAsk("generate an image of a dog"), true);
    assert.equal(detectImageAsk("create a logo for LYKN"), true);
    assert.equal(detectImageAsk("draw a cat"), true);
    assert.equal(detectImageAsk("picture of the northern lights"), true);
  });

  it("does not treat analysis or builds as image", () => {
    assert.equal(detectImageAsk("summarize this image for me"), false);
    assert.equal(detectImageAsk("build me a landing page"), false);
    assert.equal(detectImageAsk("what makes a good logo?"), false);
  });

  it("questions about an image stay in the conversation", () => {
    // Each of these once bounced to Imagine because "picture of" / "photo of"
    // anywhere in the sentence read as a generation ask.
    for (const ask of [
      "what do you think of this picture of my dog",
      "who painted the picture of the girl with the pearl earring",
      "tell me about the image of earth called pale blue dot",
      "is this a good photo of me for linkedin",
      "why does my image of the chart look blurry",
      "how do i make an image transparent in photoshop",
      "i attached a photo of my garden, what plants are these",
    ]) {
      assert.equal(detectImageAsk(ask), false, ask);
    }
  });

  it("commissions phrased as requests still register", () => {
    assert.equal(detectImageAsk("can you make a picture of a sunset"), true);
    assert.equal(detectImageAsk("make me a logo for my coffee shop"), true);
  });
});

describe("detectStudioModeRedirect", () => {
  it("sends Chat image asks to Imagine", () => {
    const redirect = detectStudioModeRedirect("generate an image of a dog", "chat");
    assert.deepEqual(redirect, { target: "imagine", label: "Imagine" });
  });

  it("leaves ordinary Chat questions in Chat", () => {
    assert.equal(detectStudioModeRedirect("what's the capital of France?", "chat"), null);
    assert.equal(detectStudioModeRedirect("summarize this image for me", "chat"), null);
  });

  it("does not bounce in-lane Imagine image asks", () => {
    assert.equal(detectStudioModeRedirect("generate an image of a dog", "imagine"), null);
  });

  it("still sends Research image asks to Imagine", () => {
    const redirect = detectStudioModeRedirect("generate an image of a dog", "research");
    assert.deepEqual(redirect, { target: "imagine", label: "Imagine" });
  });
});

describe("imagineSwitchNotice", () => {
  it("tells the user to switch to Imagine", () => {
    const notice = imagineSwitchNotice();
    assert.match(notice, /Imagine/);
    assert.match(notice, /pills at the top of the page/);
  });
});
