import test from "node:test";
import assert from "node:assert/strict";
import {
  bindBrowserTabChat,
  getAttachedChatId,
  resetBrowserChatAttach,
  resolveRailChatId,
} from "@/lib/lyknChat/browserChatAttach";
import {
  LYKN_CHAT_SEND_EVENT,
  LYKN_CHAT_STOP_EVENT,
  browserAskComposerPayload,
  browserAskStopPayload,
  browserRailIdentity,
  parseLyknChatSendDetail,
  parseLyknChatStopDetail,
} from "@/lib/lyknChat/browserChatSend";
import { resolveChatSendTarget } from "@/lib/ai/chatSendTarget";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

test("rail display and send identity are the same resolved chat id", () => {
  resetBrowserChatAttach();
  bindBrowserTabChat("tab-a", "chat-a");
  bindBrowserTabChat("tab-b", "chat-b");
  const a = browserRailIdentity({
    tabId: "tab-a",
    attachedChatId: getAttachedChatId("tab-a"),
  });
  const b = browserRailIdentity({
    tabId: "tab-b",
    attachedChatId: getAttachedChatId("tab-b"),
  });
  assert.equal(a.displayChatId, "chat-a");
  assert.equal(a.sendChatId, "chat-a");
  assert.equal(a.displayChatId, a.sendChatId);
  assert.equal(b.displayChatId, "chat-b");
  assert.equal(b.sendChatId, b.displayChatId);
  assert.equal(
    resolveRailChatId({ tabId: "tab-a", attachedChatId: getAttachedChatId("tab-a") }),
    a.sendChatId,
  );
});

test("Home route Chat B does not become the browser send target for Chat A", () => {
  const target = resolveChatSendTarget(
    { chatId: "chat-a", text: "What is this page about?", surfaceContext: { surface: "browser", tabId: "tab-a" } },
    "chat-b",
    "chat-b",
  );
  assert.equal(target.streamChatId, "chat-a");
  assert.equal(target.mountedChatId, "chat-b");
  assert.equal(target.offRoute, true);
  assert.equal(target.browserSend, true);
});

test("Home send without explicit chatId uses the mounted route", () => {
  const target = resolveChatSendTarget(undefined, "chat-home", "chat-stale");
  assert.equal(target.streamChatId, "chat-home");
  assert.equal(target.offRoute, false);
  assert.equal(target.browserSend, false);
});

test("unbound rail can start a conversation on first send", () => {
  resetBrowserChatAttach();
  const identity = browserRailIdentity({
    tabId: "tab-unbound",
    attachedChatId: getAttachedChatId("tab-unbound"),
  });
  assert.equal(identity.sendChatId, null);
  assert.equal(identity.displayChatId, null);
  assert.deepEqual(
    browserAskComposerPayload({ chatId: identity.sendChatId, tabId: "tab-unbound", text: "hi" }),
    { chatId: "", text: "hi", tabId: "tab-unbound", surface: "browser" },
  );
  assert.deepEqual(parseLyknChatSendDetail({ text: "hi", tabId: "tab-unbound" }), {
    chatId: "",
    text: "hi",
    tabId: "tab-unbound",
    files: [],
  });
});

test("browser send payload requires text plus a tab or chat, and never infers Home", () => {
  assert.equal(LYKN_CHAT_SEND_EVENT, "lykn-chat-send");
  assert.equal(parseLyknChatSendDetail({ text: "hi" }), null);
  assert.equal(parseLyknChatSendDetail({ chatId: "chat-a" }), null);
  assert.deepEqual(parseLyknChatSendDetail({ chatId: "chat-a", text: "Summarize this.", tabId: "tab-a" }), {
    chatId: "chat-a",
    text: "Summarize this.",
    tabId: "tab-a",
    files: [],
  });
  const file = new File(["hi"], "note.txt", { type: "text/plain" });
  assert.deepEqual(
    parseLyknChatSendDetail({ tabId: "tab-a", files: [file] }),
    { chatId: "", text: "", tabId: "tab-a", files: [file] },
  );
});

test("BrowserAskComposer does not send through lykn-home-chat-send", () => {
  const composer = readFileSync(join(here, "../../components/studio/agentRail/BrowserAskComposer.jsx"), "utf8");
  assert.match(composer, /LYKN_CHAT_SEND_EVENT/);
  assert.match(composer, /LYKN_CHAT_STOP_EVENT/);
  assert.match(composer, /lykn-browser-ask-bar/);
  assert.match(composer, /data-rail-stop/);
  assert.match(composer, /data-rail-plus/);
  assert.doesNotMatch(composer, /lykn-home-chat-send/);
  assert.doesNotMatch(composer, /lykn_pending_home_chat/);
  const rail = readFileSync(join(here, "../../components/studio/agentRail/StudioAgentRail.jsx"), "utf8");
  assert.match(rail, /chatId=\{railChatId\}/);
  assert.match(rail, /tabId=\{activeId/);
  assert.match(rail, /streaming=\{railStreaming\}/);
  assert.match(rail, /key=\{railChatId\}/);
  const homeBar = readFileSync(join(here, "../../components/macdesktop/HomeChatBar.jsx"), "utf8");
  assert.match(homeBar, /lykn-home-chat-send/);
});

test("browser Stop payload is chat-specific and never infers Home", () => {
  assert.equal(LYKN_CHAT_STOP_EVENT, "lykn-chat-stop");
  assert.equal(parseLyknChatStopDetail({}), null);
  assert.deepEqual(parseLyknChatStopDetail({ chatId: "chat-a" }), { chatId: "chat-a" });
  assert.deepEqual(browserAskStopPayload({ chatId: "chat-a" }), { chatId: "chat-a" });
  assert.equal(browserAskStopPayload({ chatId: "" }), null);
});
