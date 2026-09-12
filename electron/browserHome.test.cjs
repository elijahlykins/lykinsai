/**
 * The LYKN start page is an empty tab — not a website the agent can act on.
 *
 * Run: node --test electron/browserHome.test.cjs
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const {
  isAgentBrowserHomeDocument,
  isPlaceholderAgentUrl,
} = require("./ownedBrowserAct.cjs");

test("the bundled start page is a home document", () => {
  const file = path.join(__dirname, "agent-browser-home.html");
  assert.equal(fs.existsSync(file), true, "agent-browser-home.html must ship next to main");
  assert.equal(isAgentBrowserHomeDocument(`file://${file}`), true);
  assert.equal(isPlaceholderAgentUrl(`file://${file}`), true);
});

test("the older welcome document still counts as home", () => {
  assert.equal(
    isAgentBrowserHomeDocument("file:///tmp/agent-browser-welcome.html"),
    true,
  );
});

test("a real search result is not the start page", () => {
  assert.equal(isAgentBrowserHomeDocument("https://www.google.com/search?q=lykn"), false);
  assert.equal(isAgentBrowserHomeDocument("https://www.google.com/"), false);
  assert.equal(isPlaceholderAgentUrl("https://www.google.com/search?q=lykn"), false);
});

test("the start page is a plain search landing", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  assert.doesNotMatch(html, /AI Mode/);
  assert.doesNotMatch(html, /openAiMode/);
  assert.doesNotMatch(html, /LYKN Search/);
  assert.doesNotMatch(html, /I'm Feeling Lucky/);
  assert.match(html, /google\.com\/search/);
});

test("the start page uses desktop dictation and a search button", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "agent-browser-preload.cjs"), "utf8");
  assert.match(html, /Dictate/);
  assert.match(html, /id="search"/);
  assert.match(html, /aria-label="Search"/);
  assert.doesNotMatch(html, /Attach files/);
  assert.doesNotMatch(html, /id="add"/);
  assert.match(html, /ensureMic/);
  assert.match(html, /transcribe/);
  assert.doesNotMatch(html, /webkitSpeechRecognition/);
  assert.match(preload, /lykn:agent-browser-ensure-mic/);
  assert.match(preload, /lykn:agent-browser-transcribe/);
});

test("the start page stays at full size instead of shrinking with the pane", () => {
  const host = fs.readFileSync(path.join(__dirname, "agent-browser/host.cjs"), "utf8");
  const apply = host.slice(host.indexOf("function applyAgentTabZoom"), host.indexOf("function fitAgentTabsToPane"));
  assert.match(apply, /isAgentBrowserHomeUrl/);
  assert.match(apply, /isPlaceholderAgentUrl/);
  assert.match(apply, /home \? 1 : agentTabZoomForWidth/);
});

test("a floating pane eases the start page down instead of enlarging it", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  assert.match(html, /max-width: 1100px/);
  assert.match(html, /clamp\(/);
});

test("the start page is a plain white page with the brand lockup", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  assert.match(html, /background: #fff/);
  assert.match(html, /class="brand"/);
  assert.match(html, /class="wordmark"/);
  assert.doesNotMatch(html, /<canvas/);
  assert.doesNotMatch(html, /webgl/i);
});

test("the centered search bar shares the omnibox suggestion dropdown", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  const stage = fs.readFileSync(path.join(__dirname, "agent-stage.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "agent-browser-preload.cjs"), "utf8");
  // Both documents load the same engine, so the lists can't drift apart.
  assert.match(html, /src="omniboxSuggest\.js"/);
  assert.match(stage, /src="omniboxSuggest\.js"/);
  assert.match(html, /id="q-suggest"/);
  assert.match(html, /buildUrlSuggestions/);
  // History for the home dropdown goes through the sender-verified channel.
  assert.match(preload, /lykn:agent-browser-home-suggest-data/);
});

test("lykn://new-tab is still an empty tab", () => {
  assert.equal(isAgentBrowserHomeDocument("lykn://new-tab"), true);
  assert.equal(isPlaceholderAgentUrl("lykn://new-tab"), true);
});
