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
import { messageWantsDeviceInventory } from "./deviceInventoryIntent";
import {
  createStreamTypewriter,
  streamTypewriterStep,
  STREAM_TYPEWRITER_MAX_STEP,
} from "./streamTypewriter";
import { fetchYouTubeTranscriptWithWhisperRetry } from "./chatTranscription";
import { editTargetFromArtifact } from "./chatArtifacts";
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

  it("passes host chatId into local tools from send identity, not tool args", () => {
    const runner = src("src/lib/ai/chatStreamRunner.ts");
    assert.match(runner, /executeAwaitingLocalTool\(/);
    assert.match(runner, /identity\?\.routeChatId \|\| p\.identity\?\.chatId/);
    assert.doesNotMatch(runner, /chatId:\s*tc\.args/);
    // Browser agent launches are their OWN conversation: no renderer bind,
    // no sourceChatId lineage, and no chatId from model args or the host.
    const launch = src("src/lib/ai/browserAgentLaunch.ts");
    assert.doesNotMatch(launch, /bindBrowserTabChat/);
    assert.doesNotMatch(launch, /sourceChatId:/);
    assert.doesNotMatch(launch, /const chatId = String\(args\.chatId/);
    assert.doesNotMatch(launch, /getActiveThreadChatId/);
    const executor = src("src/lib/ai/localToolExecutor.ts");
    assert.match(executor, /runLocalToolNow\(tc\.name,[\s\S]*host\)/);
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

  it("background board patches never hijack the active board's React ref", () => {
    // chatMessagesRef mirrors the ACTIVE board only. If patchThreadMessages
    // reassigned it for a background board (browser-rail chat streaming while
    // another chat is mounted), the board-switch effect would persist that
    // board's messages into the outgoing board's snapshot — cross-chat mix.
    const projection = src("src/hooks/useChatThreadProjection.ts");
    assert.match(
      projection,
      /setChatMessages\(\(\) => snap\.chatMessages\);\s*\n\s*chatMessagesRef\.current = snap\.chatMessages;\s*\n\s*\}/,
    );
    assert.doesNotMatch(
      projection,
      /\}\s*\n\s*chatMessagesRef\.current = snap\.chatMessages;/,
    );
  });
});

describe("device inventory gating", () => {
  it("skips Drive and Mac apps on ordinary questions", () => {
    assert.equal(messageWantsDeviceInventory("what is photosynthesis"), false);
    assert.equal(messageWantsDeviceInventory("hello"), false);
    assert.equal(messageWantsDeviceInventory("I'm open to suggestions"), false);
    assert.match(src("src/lib/ai/chatRequestBuilder.ts"), /Promise\.all\(/);
    assert.match(src("src/lib/ai/chatRequestBuilder.ts"), /wantsInventory/);
  });

  it("loads inventory for open / launch / Drive asks", () => {
    assert.equal(messageWantsDeviceInventory("open Spotify"), true);
    assert.equal(messageWantsDeviceInventory("pull up the dashboard I made"), true);
    assert.equal(messageWantsDeviceInventory("what's on my AI Drive"), true);
  });
});

describe("stream typewriter catch-up", () => {
  it("keeps a small step for the first words", () => {
    assert.equal(streamTypewriterStep(12), 2);
    assert.ok(streamTypewriterStep(40) <= 6);
  });

  it("never dumps the whole remainder in one tick", () => {
    assert.ok(streamTypewriterStep(400) <= STREAM_TYPEWRITER_MAX_STEP);
    assert.match(src("src/lib/ai/chatStreamRunner.ts"), /streamTypewriterStep\(behind\)/);
    assert.match(src("src/lib/ai/chatStreamRunner.ts"), /export function typeStreamReply/);
    assert.match(src("src/hooks/useChatEngine.ts"), /typeStreamReply\(/);
    assert.match(src("src/hooks/useBotChatBridge.ts"), /createStreamTypewriter/);
  });

  it("holds stream painting until the turn is finished", () => {
    const runner = src("src/lib/ai/chatStreamRunner.ts");
    assert.match(runner, /Buffer the live target only/);
    assert.match(src("src/lib/ai/chatSendOrchestrator.ts"), /paint:\s*false/);
    assert.match(src("electron/overlay.js"), /Hold the typewriter until onDone/);
  });

  it("types toward the target instead of painting it all at once", () => {
    const paints: string[] = [];
    const queued: Array<() => void> = [];
    const tw = createStreamTypewriter({
      onPaint: (partial) => paints.push(partial),
      schedule: (fn) => {
        queued.push(fn);
        return queued.length;
      },
      clear: () => {},
    });
    tw.setTarget("Hello there, teammate.");
    while (queued.length) queued.shift()!();
    assert.ok(paints.length > 1);
    assert.ok(paints[0]!.length < "Hello there, teammate.".length);
    assert.equal(paints.at(-1), "Hello there, teammate.");
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

describe("edit target rides the sent prompt", () => {
  it("names an installed app and its files", () => {
    const target = editTargetFromArtifact(
      {
        id: "installed-app:app-1",
        kind: "html",
        title: "Todo",
        toolName: "lykn_build_react_artifact",
        sourceChatId: "chat-1",
        installedAppId: "app-1",
        files: [
          { path: "App.jsx", content: "export default function App(){return null}" },
          { path: "app.json", content: "{}" },
        ],
      } as any,
      "chat-1",
    );
    assert.deepEqual(target, {
      kind: "app",
      title: "Todo",
      paths: ["App.jsx", "app.json"],
    });
  });

  it("ignores an artifact from another chat", () => {
    assert.equal(
      editTargetFromArtifact(
        {
          id: "art-1",
          kind: "html",
          title: "Other",
          toolName: "lykn_build_react_artifact",
          sourceChatId: "chat-OTHER",
          code: "export default function App(){return null}",
        } as any,
        "chat-1",
      ),
      null,
    );
  });

  it("stamps the send path and message chip", () => {
    assert.match(src("src/hooks/useChatEngine.ts"), /editTargetFromArtifact/);
    assert.match(src("src/hooks/useChatEngine.ts"), /pickEditArtifact/);
    assert.match(src("src/components/lyknChat/ChatMessageItem.tsx"), /SentAppEditChip/);
  });
});
