import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ChatArtifact } from "@/lib/ai/chatArtifacts";
import {
  artifactFromAttachment,
  focusedAttachmentFromArtifact,
  isChatArtifact,
  pickEditArtifact,
} from "@/lib/lyknChat/artifactChatAttach";

const webapp: ChatArtifact = {
  id: "art-1",
  kind: "html",
  title: "Super Coin Dash",
  toolName: "lykn_build_react_artifact",
  sourceChatId: "chat-OTHER",
  code: "export default function App() { return null; }",
};

describe("focusedAttachmentFromArtifact", () => {
  it("stages a composer chip that still carries the build source", () => {
    const att = focusedAttachmentFromArtifact(webapp);
    assert.equal(att.type, "artifact");
    assert.equal(att.name, "Super Coin Dash");
    assert.equal(artifactFromAttachment(att)?.id, "art-1");
    assert.equal(artifactFromAttachment(att)?.code, webapp.code);
  });
});

describe("pickEditArtifact", () => {
  it("retags an explicitly attached build onto this chat so edits can land", () => {
    const picked = pickEditArtifact({
      attached: webapp,
      panel: null,
      chatId: "chat-1",
    });
    assert.equal(picked?.sourceChatId, "chat-1");
    assert.equal(picked?.id, "art-1");
  });

  it("prefers the attached build over the open preview panel", () => {
    const picked = pickEditArtifact({
      attached: { ...webapp, id: "attached" },
      panel: { ...webapp, id: "panel" },
      chatId: "chat-1",
    });
    assert.equal(picked?.id, "attached");
  });

  it("keeps the open panel when nothing was taken to chat", () => {
    const picked = pickEditArtifact({
      attached: null,
      panel: webapp,
      chatId: "chat-1",
    });
    assert.equal(picked?.id, "art-1");
    assert.equal(picked?.sourceChatId, "chat-OTHER");
  });
});

describe("isChatArtifact", () => {
  it("accepts a staged build that still has an id when toolName was omitted", () => {
    assert.equal(isChatArtifact({ id: "art-2", title: "Deck", kind: "html" }), true);
    assert.equal(isChatArtifact({ title: "Deck" }), false);
  });
});
