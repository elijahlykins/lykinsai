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

test("the start page is a search landing with AI Mode", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  assert.match(html, /AI Mode/);
  assert.doesNotMatch(html, /LYKN Search/);
  assert.doesNotMatch(html, /I'm Feeling Lucky/);
  assert.match(html, /openAiMode/);
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
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const apply = main.slice(main.indexOf("function applyAgentTabZoom"), main.indexOf("function fitAgentTabsToPane"));
  assert.match(apply, /isAgentBrowserHomeUrl/);
  assert.match(apply, /isPlaceholderAgentUrl/);
  assert.match(apply, /home \? 1 : agentTabZoomForWidth/);
});

test("a floating pane eases the start page down instead of enlarging it", () => {
  const html = fs.readFileSync(path.join(__dirname, "agent-browser-home.html"), "utf8");
  assert.match(html, /max-width: 1440px/);
  assert.match(html, /width: 176px/);
  assert.match(html, /width: 160px/);
});

test("lykn://new-tab is still an empty tab", () => {
  assert.equal(isAgentBrowserHomeDocument("lykn://new-tab"), true);
  assert.equal(isPlaceholderAgentUrl("lykn://new-tab"), true);
});
