// Characterization tests for the build/refine/discuss intent classifier
// extracted from useChatEngine.handleChatSend (Wave 1). Expectations are
// derived from the CURRENT implementation (and its server.js mirrors) — they
// lock existing behavior, not desired behavior.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveArtifactSendPlan, type ArtifactSendPlanInput } from "./artifactSendPlan";

const openWebapp = {
  id: "art-1",
  kind: "html",
  title: "Super Coin Dash",
  toolName: "lykn_build_react_artifact",
  sourceChatId: "chat-1",
  code: "export default function App() { return null; }",
} as any;

const baseInput = (overrides: Partial<ArtifactSendPlanInput> = {}): ArtifactSendPlanInput => ({
  text: "",
  sendMode: "none",
  streamChatId: "chat-1",
  editArtifact: null,
  studioModeInstructions: "",
  sentAttachments: [],
  aiThread: [],
  linkedAppId: undefined,
  ...overrides,
});

describe("resolveArtifactSendPlan — normal Ask", () => {
  it("plain question, no artifact: nothing armed, composer mode passes through", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({ text: "what is the capital of france?" }),
    );
    assert.equal(plan.createArmed, false);
    assert.equal(plan.refiningOpenArtifact, false);
    assert.equal(plan.discussOpenArtifact, false);
    assert.equal(plan.buildModeFresh, false);
    assert.equal(plan.effectiveComposerMode, "none");
    assert.equal(plan.createToolName, "");
  });

  it("typed commission in Chat does not silently arm Create", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({ text: "build me a todo app", sendMode: "none" }),
    );
    assert.equal(plan.createArmed, false);
    assert.equal(plan.effectiveComposerMode, "none");
    assert.equal(plan.createToolName, "");
  });
});

describe("resolveArtifactSendPlan — Build", () => {
  it("armed Build with a typed commission and no open artifact starts fresh", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({ text: "build me a todo app", sendMode: "create:webapp" }),
    );
    assert.equal(plan.createArmed, true);
    assert.equal(plan.typedNewDeliverableAsk, true);
    assert.equal(plan.buildModeFresh, true);
    assert.equal(plan.refiningOpenArtifact, false);
    assert.equal(plan.discussOpenArtifact, false);
    assert.equal(plan.effectiveComposerMode, "create:webapp");
    assert.equal(plan.createToolName, "lykn_build_react_artifact");
  });

  it("explicit different-deliverable ask with an open artifact forces fresh (app link should clear)", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "now build a completely new game",
        sendMode: "create:webapp",
        editArtifact: openWebapp,
      }),
    );
    assert.equal(plan.createArmed, true);
    assert.equal(plan.buildModeFresh, true);
    assert.equal(plan.refiningOpenArtifact, false);
    assert.equal(plan.discussOpenArtifact, false);
    // createArmed && !refiningOpenArtifact is the hook's cue to forget the
    // chat's installed-app link before this send.
  });
});

describe("resolveArtifactSendPlan — refine open artifact", () => {
  it("armed Build + same-kind open artifact + surgical tweak refines, demoting composer mode", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "fix the button color",
        sendMode: "create:webapp",
        editArtifact: openWebapp,
      }),
    );
    assert.equal(plan.refiningOpenArtifact, true);
    assert.equal(plan.discussOpenArtifact, false);
    assert.equal(plan.buildModeFresh, false);
    assert.equal(plan.effectiveComposerMode, "none");
  });

  it("artifact from ANOTHER chat does not refine here", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "fix the button color",
        sendMode: "create:webapp",
        editArtifact: { ...openWebapp, sourceChatId: "chat-OTHER" },
      }),
    );
    assert.equal(plan.refiningOpenArtifact, false);
    assert.equal(plan.discussOpenArtifact, false);
  });
});

describe("resolveArtifactSendPlan — discuss open artifact", () => {
  it("question in Chat mode about the open artifact takes the discuss-only path", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({ text: "what does this app do?", editArtifact: openWebapp }),
    );
    assert.equal(plan.discussOpenArtifact, true);
    assert.equal(plan.refiningOpenArtifact, false);
    assert.equal(plan.createArmed, false);
    assert.equal(plan.effectiveComposerMode, "none");
  });
});

describe("resolveArtifactSendPlan — sticky instructions", () => {
  it("sticky Build + pure question demotes the armed composer to conversation", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "why is the sky blue?",
        sendMode: "create:webapp",
        studioModeInstructions: "The user is in Build mode.",
      }),
    );
    assert.equal(plan.createArmed, false);
    assert.equal(plan.effectiveComposerMode, "none");
    assert.equal(plan.buildModeFresh, false);
  });

  it("sticky Build session keeps a mutation ask armed even with sendMode none", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "add a dark mode toggle",
        studioModeInstructions: "The user is in Build mode.",
        editArtifact: openWebapp,
      }),
    );
    assert.equal(plan.refiningOpenArtifact, true);
    assert.equal(plan.discussOpenArtifact, false);
    assert.equal(plan.effectiveComposerMode, "none");
  });

  it("sticky Imagine + question stays in conversation; commission stays in image mode", () => {
    const question = resolveArtifactSendPlan(
      baseInput({
        text: "what do you think of it?",
        sendMode: "image",
        studioModeInstructions: "The user is in Imagine mode.",
      }),
    );
    assert.equal(question.effectiveComposerMode, "none");
    const commission = resolveArtifactSendPlan(
      baseInput({
        text: "draw a red dragon",
        sendMode: "image",
        studioModeInstructions: "The user is in Imagine mode.",
      }),
    );
    assert.equal(commission.effectiveComposerMode, "image");
  });
});

describe("resolveArtifactSendPlan — \"make the app …\" refines, never rebuilds", () => {
  it("Build armed + open build: 'make the app darker' refines in place", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "make the app darker",
        sendMode: "create:webapp",
        editArtifact: openWebapp,
      }),
    );
    assert.equal(plan.typedNewDeliverableAsk, false);
    assert.equal(plan.buildModeFresh, false);
    assert.equal(plan.refiningOpenArtifact, true);
  });

  it("Build armed + open build: 'make the game have a settings page' refines", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "make the game have a settings page",
        sendMode: "create:webapp",
        editArtifact: openWebapp,
      }),
    );
    assert.equal(plan.buildModeFresh, false);
    assert.equal(plan.refiningOpenArtifact, true);
  });

  it("installed-app edit: 'create a quiz page in the app' stays an edit of THAT app", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "create a quiz page in the app",
        sendMode: "create:webapp",
        editArtifact: { ...openWebapp, installedAppId: "app-9" },
        linkedAppId: "app-9",
      }),
    );
    assert.equal(plan.typedNewDeliverableAsk, false);
    assert.equal(plan.buildModeFresh, false);
    assert.equal(plan.refiningOpenArtifact, true);
  });

  it("installed-app edit in Chat mode: 'make the app darker' still edits, not a new build", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "make the app darker",
        editArtifact: { ...openWebapp, installedAppId: "app-9" },
        linkedAppId: "app-9",
      }),
    );
    assert.equal(plan.refiningOpenArtifact, true);
    assert.equal(plan.discussOpenArtifact, false);
  });

  it("installed-app edit: explicit 'build me another app' still starts fresh", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "build me another app for tracking workouts",
        sendMode: "create:webapp",
        editArtifact: { ...openWebapp, installedAppId: "app-9" },
        linkedAppId: "app-9",
      }),
    );
    assert.equal(plan.buildModeFresh, true);
    assert.equal(plan.refiningOpenArtifact, false);
  });
});

describe("resolveArtifactSendPlan — linked installed app", () => {
  it("installed-app chat keeps a mutation ask as an edit even in Chat mode", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "add a dark mode toggle",
        editArtifact: openWebapp,
        linkedAppId: "app-9",
      }),
    );
    assert.equal(plan.refiningOpenArtifact, true);
    assert.equal(plan.discussOpenArtifact, false);
  });

  it("visual-overhaul of an installed app is an in-place rebuild (refine), not fresh", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "make it look just like this",
        sendMode: "create:webapp",
        editArtifact: { ...openWebapp, installedAppId: "app-9" },
        sentAttachments: [{ type: "image", url: "https://x/img.png" }],
      }),
    );
    assert.equal(plan.refiningOpenArtifact, true);
    assert.equal(plan.effectiveComposerMode, "none");
  });
});

describe("resolveArtifactSendPlan — attachments affecting intent", () => {
  it("reference-image rebuild ask WITHOUT an installed app goes fresh, not refine", () => {
    const plan = resolveArtifactSendPlan(
      baseInput({
        text: "make it look just like this",
        sendMode: "create:webapp",
        editArtifact: openWebapp,
        sentAttachments: [{ type: "image", url: "https://x/img.png" }],
      }),
    );
    assert.equal(plan.buildModeFresh, true);
    assert.equal(plan.refiningOpenArtifact, false);
    assert.equal(plan.effectiveComposerMode, "create:webapp");
  });
});
