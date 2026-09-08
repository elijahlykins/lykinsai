import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectImageAsk,
  detectStudioModeRedirect,
  detectVideoAsk,
  imagineSwitchNotice,
} from "./studioModeIntent.ts";

describe("detectVideoAsk", () => {
  it("detects video commissions in any phrasing", () => {
    // Imagine diverts these to the video lane even when the composer toggle
    // sits on images — "make me a video" answered with four stills is the
    // exact bug this matcher exists to prevent.
    for (const ask of [
      "make me a video of a porsche drifting",
      "can you create a video of waves at sunset",
      "generate a 10 second clip of rain on a window",
      "a video of a hummingbird in slow motion",
      "make a short film about a robot learning to paint",
      "create an animation of the solar system",
      "animate this photo of my dog",
      "make me a cinematic clip of a city at night",
    ]) {
      assert.equal(detectVideoAsk(ask), true, ask);
    }
  });

  it("video-flavored image asks stay images", () => {
    for (const ask of [
      "make me a video game poster",
      "create a movie poster for my short",
      "draw a film noir portrait of a detective",
      "make me some clip art of vegetables",
      "make a video thumbnail for my channel",
      "generate a movie still of a spaceship bridge",
    ]) {
      assert.equal(detectVideoAsk(ask), false, ask);
    }
  });

  it("questions and analysis about video stay conversational", () => {
    for (const ask of [
      "what makes a good video for tiktok",
      "how do i make a video loop in premiere",
      "summarize this video for me",
      "is this a good clip of my presentation",
    ]) {
      assert.equal(detectVideoAsk(ask), false, ask);
    }
  });
});

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
  it("never bounces on keywords — the selected mode owns the prompt", () => {
    assert.equal(detectStudioModeRedirect("generate an image of a dog", "chat"), null);
    assert.equal(detectStudioModeRedirect("generate an image of a dog", "build"), null);
    assert.equal(detectStudioModeRedirect("generate an image of a dog", "research"), null);
    assert.equal(detectStudioModeRedirect("generate an image of a dog", "imagine"), null);
    assert.equal(detectStudioModeRedirect("build me a landing page", "imagine"), null);
  });

  it("does not treat a Build brief that mentions graphics as an image hop", () => {
    const brief =
      "We are going to build a 3d anatomy study guide interactive application. " +
      "It will be a 3d model of the male human body included should be the following. " +
      "Separate models of each body system, with explanations of each part in a floating hover box. " +
      "Have scroll animations to separate the body on scroll, rotate around the body, " +
      "click on each part and system and read about it's functions. " +
      "Make the graphics as realistic as possible. Show the skeleton, muscles, and so on. " +
      "put it all on a white background and make it the ui look neumorphic";
    for (const mode of ["chat", "build", "imagine", "research"] as const) {
      assert.equal(detectStudioModeRedirect(brief, mode), null, mode);
    }
  });

  it("leaves ordinary Chat questions in Chat", () => {
    assert.equal(detectStudioModeRedirect("what's the capital of France?", "chat"), null);
    assert.equal(detectStudioModeRedirect("summarize this image for me", "chat"), null);
  });
});

describe("imagineSwitchNotice", () => {
  it("tells the user to switch to Imagine", () => {
    const notice = imagineSwitchNotice();
    assert.match(notice, /Imagine/);
    assert.match(notice, /pills at the top of the page/);
  });
});
