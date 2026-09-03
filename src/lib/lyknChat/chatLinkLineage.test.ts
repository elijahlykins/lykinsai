import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
function src(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

test("openInStudioBrowser no longer guesses the active Home chat", () => {
  const open = src("src/lib/lyknChat/openInStudioBrowser.ts");
  assert.doesNotMatch(open, /getActiveThreadChatId/);
  assert.doesNotMatch(open, /function activeChatId/);
  assert.match(open, /function explicitChatId/);
});

test("markdown anchors inherit the owning chatId, not Home", () => {
  const md = src("src/components/lyknChat/chatMarkdownComponents.ts");
  assert.match(md, /chatOwnedMarkdownAnchor\(ownedChatId\)/);
  assert.match(md, /handleLyknBrowserClick\(e, url, owned\)/);
  assert.doesNotMatch(md, /getActiveThreadChatId/);
});

test("ChatMessageItem source chips pass the rendered message chatId", () => {
  const item = src("src/components/lyknChat/ChatMessageItem.tsx");
  assert.match(item, /const linkOpts = studioOpenChatOpts\(chatId\)/);
  assert.match(item, /handleLyknBrowserClick\(e, href, src\.title, linkOpts\)/);
  assert.match(item, /handleLyknBrowserClick\(e, href, domain, linkOpts\)/);
  assert.doesNotMatch(item, /getActiveThreadChatId/);
});

test("AttachedChatThread rail links inherit the rail chat, not Home", () => {
  const rail = src("src/components/lyknChat/AttachedChatThread.tsx");
  assert.match(rail, /chatOwnedMarkdownAnchor\(id\)/);
  assert.match(rail, /BROWSER_MD_COMPONENTS/);
  assert.match(rail, /handleLyknBrowserClick/);
  assert.doesNotMatch(rail, /getActiveThreadChatId/);
});

test("LinkPreview only binds when a chatId prop is provided", () => {
  const preview = src("src/components/LinkPreview.tsx");
  assert.match(preview, /chatId\?: string \| null/);
  assert.match(preview, /handleLyknBrowserClick\(e, safeHref, studioOpenChatOpts\(chatId\)\)/);
  assert.doesNotMatch(preview, /getActiveThreadChatId/);
});

test("Studio research sources pass the report's owning chatId", () => {
  const chrome = src("src/components/lyknChat/StudioChatChrome.tsx");
  assert.match(chrome, /openInStudioBrowser\(url, undefined, studioOpenChatOpts\(chatId\)\)/);
  const page = src("src/pages/LyknChat.tsx");
  assert.match(page, /<StudioResearchSidebar[\s\S]*chatId=\{routeChatId \|\| chatId/);
});

test("webpage preload still cannot choose a conversation", () => {
  const page = src("electron/agent-browser-preload.cjs");
  assert.doesNotMatch(page, /studioOpenUrl/);
  assert.doesNotMatch(page, /openExternal/);
  assert.doesNotMatch(page, /lykn:open-url/);
  assert.doesNotMatch(page, /chatId/);
});

test("trusted open-url and studio-open-url can carry chatId", () => {
  const preload = src("electron/preload.cjs");
  assert.match(preload, /chatId: typeof opts\?\.chatId === "string"/);
  const overlay = src("electron/ipc/overlayAi.cjs");
  assert.match(overlay, /sourceChatId/);
  assert.match(overlay, /isTrustedLyknIpcSender/);
  const bridge = src("electron/ipc/agentBridge.cjs");
  assert.match(bridge, /ipcMain.handle\("lykn:studio-open-url"/);
  assert.match(bridge, /untrustedSenderResult/);
});
