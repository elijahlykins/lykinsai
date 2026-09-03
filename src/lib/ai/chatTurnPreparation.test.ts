// Characterization for the turn-preparation stage of the send pipeline.
// Locks current string budgets and truncation — not a spec of ideal copy.
//
// Run: node --import ./scripts/test-alias-loader.mjs --test src/lib/ai/chatTurnPreparation.test.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachmentsForPrompt,
  buildAttachmentContext,
  buildThreadHistory,
  buildConversationArray,
  collectThreadFolderAttachments,
  folderPathFromAttachment,
} from "./chatTurnPreparation";
import type { FocusedChatAttachment, PromptMessage } from "@/lib/lyknChat/chatTurnTypes";

function att(partial: Partial<FocusedChatAttachment> & Pick<FocusedChatAttachment, "type">): FocusedChatAttachment {
  return {
    id: partial.id || "a1",
    url: partial.url ?? "",
    name: partial.name || "Untitled",
    mime: partial.mime || "",
    size: partial.size ?? 0,
    ...partial,
  };
}

describe("buildAttachmentContext", () => {
  it("returns empty string when nothing is attached", () => {
    assert.equal(buildAttachmentContext([]), "");
  });

  it("prefixes a folder listing with the desktop-folder contract", () => {
    const ctx = buildAttachmentContext([
      att({ type: "folder", name: "Docs", vaultContent: "file.txt\nnotes.md" }),
    ]);
    assert.match(ctx, /^[\s\S]*\[Attached content\]/);
    assert.match(ctx, /Desktop folder "Docs"/);
    assert.match(ctx, /file\.txt/);
    assert.match(ctx, /local_list_dir/);
    assert.match(ctx, /Do not hand this off/);
  });

  it("carries a prior desktop folder onto the next turn", () => {
    const folder = att({
      type: "folder",
      name: "Docs",
      localPath: "/Users/me/Docs",
      vaultContent: "Attached folder \"Docs\"\nPath: /Users/me/Docs\n  - agents.md",
    });
    const messages: PromptMessage[] = [
      {
        id: "1",
        role: "user",
        content: "what's in here",
        kind: "prompt",
        attachments: [folder],
      },
    ];
    const prior = collectThreadFolderAttachments(messages, []);
    assert.equal(prior.length, 1);
    assert.equal(folderPathFromAttachment(prior[0]), "/Users/me/Docs");
    const merged = attachmentsForPrompt([], messages);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, "Docs");
  });

  it("does not spell out a data URL", () => {
    const ctx = buildAttachmentContext([
      att({ type: "image", name: "shot.png", url: "data:image/png;base64,AAAA" }),
    ]);
    assert.doesNotMatch(ctx, /data:image/);
    assert.match(ctx, /Image "shot\.png"/);
  });

  it("includes OCR and vision description on images", () => {
    const ctx = buildAttachmentContext([
      att({
        type: "image",
        name: "card.png",
        url: "https://example.com/card.png",
        ocrText: "HELLO",
        aiDescription: "a red card",
      }),
    ]);
    assert.match(ctx, /What the image shows: a red card/);
    assert.match(ctx, /Text extracted from this image \(OCR/);
    assert.match(ctx, /HELLO/);
  });

  it("names an attached artifact so the model sees it on every mode", () => {
    const ctx = buildAttachmentContext([
      att({
        type: "artifact",
        name: "Super Coin Dash",
        artifact: { toolName: "lykn_build_react_artifact", title: "Super Coin Dash" },
      }),
    ]);
    assert.match(ctx, /Attached artifact "Super Coin Dash"/);
    assert.match(ctx, /build react artifact/);
  });
});

describe("buildThreadHistory", () => {
  it("keeps the last 16 turns and caps each at 1200 chars", () => {
    const thread = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: "x".repeat(1300),
    }));
    const history = buildThreadHistory(thread);
    const lines = history.split("\n");
    assert.equal(lines.length, 16);
    assert.ok(lines.every((line) => line.endsWith("…")));
    assert.ok(lines[0].startsWith("User:"));
  });
});

describe("buildConversationArray", () => {
  it("rebuilds user/assistant pairs and appends the capped send", () => {
    const messages: PromptMessage[] = [
      {
        id: "1",
        role: "user",
        content: "hi",
        kind: "prompt",
        aiResponse: "hello",
        aiModel: "lykn",
        createdAt: "2026-01-01T00:00:00.000Z",
        aiCompletedAt: "2026-01-01T00:00:01.000Z",
      },
    ];
    const arr = buildConversationArray(messages, "next");
    assert.equal(arr.length, 3);
    assert.deepEqual(
      arr.slice(0, 2).map((t) => t.role),
      ["user", "assistant"],
    );
    assert.equal(arr[2].role, "user");
    assert.equal(arr[2].content, "next");
  });

  it("keeps legacy non-user rows as assistant turns", () => {
    const messages: PromptMessage[] = [
      {
        id: "legacy",
        role: "assistant" as any,
        content: "old reply",
        kind: "prompt",
        aiModel: "lykn",
        aiCompletedAt: "2026-01-01T00:00:01.000Z",
      },
    ];
    const arr = buildConversationArray(messages, "now");
    assert.equal(arr[0].role, "assistant");
    assert.equal(arr[0].content, "old reply");
    assert.equal(arr[1].content, "now");
  });
});
