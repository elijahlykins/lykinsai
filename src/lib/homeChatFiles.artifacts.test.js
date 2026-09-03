import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  attachArtifactToHomeChat,
  clearStagedHomeChatArtifacts,
  homeChatArtifactKey,
  listStagedHomeChatArtifacts,
  takeQueuedHomeChatArtifacts,
  unstageHomeChatArtifact,
} from "./homeChatFiles.js";

const webapp = {
  id: "art-1",
  kind: "html",
  title: "Super Coin Dash",
  toolName: "lykn_build_react_artifact",
};

beforeEach(() => {
  clearStagedHomeChatArtifacts();
});

describe("attachArtifactToHomeChat", () => {
  it("keeps the build staged so every chat bar can show the same chip", () => {
    attachArtifactToHomeChat(webapp);
    assert.deepEqual(listStagedHomeChatArtifacts().map(homeChatArtifactKey), ["art-1"]);
    assert.equal(homeChatArtifactKey(takeQueuedHomeChatArtifacts()[0]), "art-1");
    assert.equal(listStagedHomeChatArtifacts().length, 1);
  });

  it("does not stack a second chip for the same build", () => {
    attachArtifactToHomeChat(webapp);
    attachArtifactToHomeChat({ ...webapp, title: "Renamed" });
    assert.equal(listStagedHomeChatArtifacts().length, 1);
  });

  it("drops a chip from every bar when it is unstaged", () => {
    attachArtifactToHomeChat(webapp);
    unstageHomeChatArtifact(homeChatArtifactKey(webapp));
    assert.equal(listStagedHomeChatArtifacts().length, 0);
  });
});
