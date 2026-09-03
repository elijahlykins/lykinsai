import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { browserPageContextForRequest } from "@/lib/lyknChat/browserSurfaceContext";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");

test("request builder sends browserPageContext only for browser surface", () => {
  const builder = readFileSync(join(root, "src/lib/ai/chatRequestBuilder.ts"), "utf8");
  assert.match(builder, /browserPageContextForRequest/);
  assert.match(builder, /browserPageContext/);
  assert.match(builder, /requestBody\.browserAsk = true/);
  assert.match(builder, /localModeOn && !browserAsk/);
  const page = browserPageContextForRequest({
    surface: "browser",
    tabId: "tab-a",
    page: { url: "https://apple.com/", title: "Apple", text: "iPhone article" },
  });
  assert.equal(page?.url, "https://apple.com/");
  assert.equal(
    browserPageContextForRequest(undefined),
    undefined,
  );
});

test("page context is request-only and not pushed onto chatMessages", () => {
  const orch = readFileSync(join(root, "src/lib/ai/chatSendOrchestrator.ts"), "utf8");
  assert.match(orch, /surfaceContext\?:/);
  assert.doesNotMatch(orch, /The user is viewing/);
  const engine = readFileSync(join(root, "src/hooks/useChatEngine.ts"), "utf8");
  assert.match(engine, /resolveChatSendTarget/);
  assert.match(engine, /hydrateThreadSnapshot/);
  assert.match(engine, /if \(!offRoute\) chatMessagesRef/);
  assert.doesNotMatch(engine, /SYSTEM:\s*The user is viewing/);
  const session = readFileSync(join(root, "src/hooks/useStudioChatSession.ts"), "utf8");
  assert.match(session, /LYKN_CHAT_SEND_EVENT/);
  assert.match(session, /LYKN_CHAT_STOP_EVENT/);
  assert.match(session, /fetchTrustedBrowserTabPage/);
});
