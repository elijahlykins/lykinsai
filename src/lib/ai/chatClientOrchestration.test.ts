// Characterization for C3B client-orchestration ownership.
// Locks the send-pipeline stage split, dead canvas-path absence, and
// attachment-type consolidation. Not a product spec.
//
// Run: node --import ./scripts/test-alias-loader.mjs --test src/lib/ai/chatClientOrchestration.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildAttachmentContext } from "./chatTurnPreparation";
import { fetchYouTubeTranscriptWithWhisperRetry } from "./chatTranscription";
import type { FocusedChatAttachment } from "@/lib/lyknChat/chatTurnTypes";
import type { ChatAttachmentLike } from "@/lib/chat/chatAttachmentFile";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

function src(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

describe("send pipeline stage modules", () => {
  it("exports the facade and each lifecycle stage", () => {
    const facade = src("src/lib/ai/chatSendOrchestrator.ts");
    assert.match(facade, /export async function orchestrateChatSend/);
    assert.match(facade, /export \{ buildAttachmentContext \}/);
    assert.match(facade, /export \{ maybeAutoNameChat \}/);
    assert.equal(typeof buildAttachmentContext, "function");
    assert.equal(typeof fetchYouTubeTranscriptWithWhisperRetry, "function");
    assert.match(src("src/lib/ai/chatRequestBuilder.ts"), /export async function buildChatRequestBody/);
    assert.match(src("src/lib/ai/chatStreamRunner.ts"), /export async function runChatStream/);
    assert.match(src("src/lib/ai/chatResultReconciliation.ts"), /export async function postProcessResponse/);
  });

  it("documents the load-bearing stage order in the facade header", () => {
    const text = src("src/lib/ai/chatSendOrchestrator.ts");
    const order = [
      "inlineDeviceLocalImages",
      "ocrImageAttachments",
      "buildAttachmentContext",
      "transcribeAttachments",
      "fetchYouTubeGrounding",
      "buildChatRequestBody",
      "runChatStream",
      "postProcessResponse",
    ];
    let cursor = 0;
    for (const name of order) {
      const at = text.indexOf(name, cursor);
      assert.ok(at >= 0, `missing ${name} after previous stage`);
      cursor = at + name.length;
    }
  });
});

describe("dead canvas / action execution", () => {
  it("does not define handleActionPath", () => {
    assert.doesNotMatch(src("src/lib/ai/chatSendOrchestrator.ts"), /function handleActionPath/);
    assert.doesNotMatch(src("src/pages/LyknChat.tsx"), /handleOrganizeIdeas|handleProjectSuggestions|handleProjectSummary/);
    assert.doesNotMatch(src("src/store/aiStore.ts"), /organizeIdeas|getAISuggestions|generateProjectSummary/);
  });

  it("does not keep a live add-to-grid creation path", () => {
    assert.doesNotMatch(src("src/components/lyknChat/LyknChatView.tsx"), /addChatResponseToGrid|canAddToGrid|GridIcon/);
    assert.doesNotMatch(src("src/components/lyknChat/ChatMessageItem.tsx"), /addChatResponseToGrid|canAddToGrid|GridIcon/);
    assert.doesNotMatch(src("src/pages/LyknChat.tsx"), /addChatResponseToGrid/);
  });
});

describe("single engine / stream owner", () => {
  it("useChatEngine remains the only send facade", () => {
    const engine = src("src/hooks/useChatEngine.ts");
    assert.match(engine, /orchestrateChatSend/);
    assert.match(engine, /useChatThreadProjection/);
    assert.match(engine, /useChatComposerAttachments/);
    assert.doesNotMatch(engine, /chatRuntimeManager|useLyknChatEverything|chatMegaController/);
    const projection = src("src/hooks/useChatThreadProjection.ts");
    assert.doesNotMatch(projection, /orchestrateChatSend/);
    assert.doesNotMatch(projection, /new AbortController/);
  });
});

describe("attachment type consolidation", () => {
  it("treats a FocusedChatAttachment as a ChatAttachmentLike / sent chip", () => {
    const focused: FocusedChatAttachment = {
      id: "att-1",
      type: "link",
      url: "https://example.com",
      name: "Example",
      mime: "",
      size: 0,
      linkTitle: "Example",
    };
    const like: ChatAttachmentLike = focused;
    assert.equal(like.id, "att-1");
    assert.equal(like.linkTitle, "Example");
    assert.match(
      src("src/components/lyknChat/SentChatAttachment.tsx"),
      /export type SentChatAttachmentData = FocusedChatAttachment/,
    );
  });
});
