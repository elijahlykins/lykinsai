import test from "node:test";
import assert from "node:assert/strict";
import {
  getAttachedChatId,
  resetBrowserChatAttach,
} from "@/lib/lyknChat/browserChatAttach";
import {
  resetStartBrowserTabChat,
  startChatForUnboundBrowserTab,
} from "@/lib/lyknChat/startBrowserTabChat";

test("unbound first send creates a chat and binds that tab only", async () => {
  resetBrowserChatAttach();
  resetStartBrowserTabChat();
  let created = 0;
  const chatId = await startChatForUnboundBrowserTab({
    tabId: "tab-empty",
    userId: "user-1",
    createChat: async () => {
      created += 1;
      return { chatId: "chat-new" };
    },
  });
  assert.equal(chatId, "chat-new");
  assert.equal(created, 1);
  assert.equal(getAttachedChatId("tab-empty"), "chat-new");
  assert.equal(getAttachedChatId("other-tab"), null);
});

test("a second send on the same tab reuses the bind and does not mint another chat", async () => {
  resetBrowserChatAttach();
  resetStartBrowserTabChat();
  let created = 0;
  const createChat = async () => {
    created += 1;
    return { chatId: "chat-once" };
  };
  const first = startChatForUnboundBrowserTab({
    tabId: "tab-empty",
    userId: "user-1",
    createChat,
  });
  const second = startChatForUnboundBrowserTab({
    tabId: "tab-empty",
    userId: "user-1",
    createChat,
  });
  assert.equal(await first, "chat-once");
  assert.equal(await second, "chat-once");
  assert.equal(created, 1);
});

test("unbound first send never uses another chat id as a default", async () => {
  resetBrowserChatAttach();
  resetStartBrowserTabChat();
  const chatId = await startChatForUnboundBrowserTab({
    tabId: "tab-empty",
    userId: "user-1",
    createChat: async () => ({ chatId: "chat-minted" }),
  });
  assert.equal(chatId, "chat-minted");
  assert.notEqual(chatId, "chat-home");
});

test("without a signed-in user the tab stays unbound", async () => {
  resetBrowserChatAttach();
  resetStartBrowserTabChat();
  const chatId = await startChatForUnboundBrowserTab({
    tabId: "tab-empty",
    userId: "",
    createChat: async () => ({ chatId: "chat-nope" }),
  });
  assert.equal(chatId, null);
  assert.equal(getAttachedChatId("tab-empty"), null);
});
