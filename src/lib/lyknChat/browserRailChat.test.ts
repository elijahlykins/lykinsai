import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
function src(rel: string) {
  return readFileSync(join(root, rel), "utf8");
}

test("browser rail reuses Home chat primitives instead of a second renderer", () => {
  const thread = src("src/components/lyknChat/AttachedChatThread.tsx");
  const md = src("src/components/lyknChat/chatMarkdownComponents.ts");
  assert.match(md, /export const BROWSER_MD_COMPONENTS/);
  assert.match(md, /STATIC_MD_COMPONENTS/);
  assert.match(thread, /BROWSER_MD_COMPONENTS/);
  assert.match(thread, /lykn-user-prompt-bubble/);
  assert.match(thread, /lykn-chat-ai-text/);
  assert.match(thread, /ThinkingIndicator/);
  assert.match(thread, /RailSourceChips/);
  assert.doesNotMatch(thread, /LyknChatView/);
  assert.doesNotMatch(thread, /iframe/);
});

test("rail Stop is shown while that chat streams and targets railChatId", () => {
  const composer = src("src/components/studio/agentRail/BrowserAskComposer.jsx");
  const session = src("src/hooks/useStudioChatSession.ts");
  const rail = src("src/components/studio/agentRail/StudioAgentRail.jsx");
  assert.match(composer, /streaming/);
  assert.match(composer, /browserAskStopPayload\(\{ chatId \}\)/);
  assert.match(composer, /LYKN_CHAT_STOP_EVENT/);
  assert.match(session, /parseLyknChatStopDetail/);
  assert.match(session, /handleStopAi\(parsed\.chatId\)/);
  assert.match(rail, /streaming=\{railStreaming\}/);
  assert.match(rail, /getThreadSnapshot\(railChatId\)/);
});

test("unbound rail can send and tab switches remount the thread", () => {
  const rail = src("src/components/studio/agentRail/StudioAgentRail.jsx");
  const composer = src("src/components/studio/agentRail/BrowserAskComposer.jsx");
  const session = src("src/hooks/useStudioChatSession.ts");
  assert.match(rail, /disabled=\{!activeId\}/);
  assert.doesNotMatch(rail, /disabled=\{unbound\}/);
  assert.match(rail, /key=\{railChatId\}/);
  assert.match(rail, /Ask about this page/);
  assert.match(rail, /LYKN Chat on Home or a custom agent/);
  assert.match(composer, /browserAskComposerPayload\(\{ chatId, tabId, text, files \}\)/);
  assert.match(session, /startChatForUnboundBrowserTab/);
});

test("opening the browser rail does not unmount the Home chat bar", () => {
  const studio = src("src/pages/Studio.jsx");
  const homeMount = studio.slice(studio.indexOf("<HomeChatBar"));
  assert.match(studio, /<HomeChatBar/);
  assert.doesNotMatch(
    homeMount.slice(0, 400),
    /railAttachedOpen/,
  );
  assert.doesNotMatch(studio, /!railAttachedOpen &&\s*\(\s*<HomeChatBar/);
});

test("browser and rail share one pane with a hairline join", () => {
  const body = src("src/components/studio/StudioBrowserBody.jsx");
  const layout = src("src/components/studio/browserPaneLayout.js");
  const rail = src("src/components/studio/agentRail/StudioAgentRail.jsx");
  const studio = src("src/pages/Studio.jsx");
  assert.match(body, /lykn-browser-pane/);
  assert.match(layout, /BROWSER_VIEW_RADIUS = 14/);
  assert.match(studio, /radius: BROWSER_VIEW_RADIUS/);
  assert.match(studio, /railOpen=\{railAttachedOpen\}/);
  assert.match(rail, /bg-\[#f3f2f0\]/);
  assert.match(rail, /border-l border-black\/\[0\.08\]/);
  assert.doesNotMatch(rail, /rounded-r-\[14px\]/);
  assert.doesNotMatch(rail, /bg-\[#f7f6f4\]/);
});

test("browser rail message ink stays black on the light pane", () => {
  const css = src("src/styles/studio-shell.css");
  const thread = src("src/components/lyknChat/AttachedChatThread.tsx");
  assert.match(css, /\.lykn-browser-rail[\s\S]*color:\s*#000/);
  assert.match(css, /\.lykn-browser-rail \.lykn-outline-spinner[\s\S]*color:\s*#000/);
  assert.match(css, /\.lykn-browser-ask-field/);
  assert.match(thread, /className="lykn-rail-md lykn-chat-ai-text[^"]*text-black"/);
  assert.doesNotMatch(thread, /lykn-chat-ai-text[^"]*dark:text-white/);
});

test("rail re-reads the live snapshot so Home typewriter ticks paint", () => {
  const thread = src("src/components/lyknChat/AttachedChatThread.tsx");
  const projection = src("src/hooks/useChatThreadProjection.ts");
  assert.match(thread, /setRuntimeRev/);
  assert.match(thread, /getThreadSnapshot\(id\)/);
  assert.match(thread, /railShowsWaitingIndicator/);
  assert.doesNotMatch(thread, /setSnap\(readSnap/);
  assert.match(projection, /dispatchThreadRuntimeChange\(String\(bid\)\)/);
});

test("rail composer is the default Home pill with a plus button", () => {
  const composer = src("src/components/studio/agentRail/BrowserAskComposer.jsx");
  assert.match(composer, /lykn-browser-ask-bar/);
  assert.match(composer, /rounded-full py-1\.5 pl-1\.5 pr-1\.5/);
  assert.match(composer, /data-rail-plus/);
  assert.match(composer, /<Plus /);
  assert.match(composer, /Vault/);
  assert.match(composer, /Finder/);
  assert.doesNotMatch(composer, /LyknChatComposer/);
  assert.doesNotMatch(composer, /compact=/);
  assert.doesNotMatch(composer, /lykn-chat-neu-chat-shell/);
  assert.doesNotMatch(composer, /chatBarShape/);
  assert.doesNotMatch(composer, /useAppearance/);
});

test("session still fetches page context from the initiating tab", () => {
  const session = src("src/hooks/useStudioChatSession.ts");
  assert.match(session, /fetchTrustedBrowserTabPage\(parsed\.tabId\)/);
  assert.match(session, /LYKN_CHAT_SEND_EVENT/);
  assert.match(session, /LYKN_CHAT_STOP_EVENT/);
});

test("rail copy says ask-only and points agentic work to Home or a custom agent", () => {
  const rail = src("src/components/studio/agentRail/StudioAgentRail.jsx");
  assert.match(rail, /Ask only/);
  assert.match(rail, /Ask about this page/);
  assert.match(rail, /LYKN Chat on Home or a custom agent/);
  assert.doesNotMatch(rail, /Start a conversation/);
});
