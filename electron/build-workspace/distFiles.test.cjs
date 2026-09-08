// Run: node --test electron/build-workspace/distFiles.test.cjs
//
// The dist collector is what stands between "the agent ran npm run build" and
// "the user has an app in their dock", so what matters here is faithfulness:
// the right folder is chosen, text stays text, binary survives the TEXT
// column as base64, and a folder that is not a build is refused rather than
// installed broken.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const distFiles = require("./distFiles.cjs");

let tmp;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-dist-test-"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function project(name, layout) {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(layout)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

// ---------------------------------------------------------------------------
// findDistDir
// ---------------------------------------------------------------------------

test("prefers dist/ over a root index.html", () => {
  const root = project("vite-app", {
    "index.html": "<html>dev shell</html>",
    "dist/index.html": "<html>built</html>",
  });
  assert.equal(distFiles.findDistDir(root), path.join(root, "dist"));
});

test("falls back to a root index.html for plain sites", () => {
  const root = project("plain-site", { "index.html": "<html>hi</html>" });
  assert.equal(distFiles.findDistDir(root), root);
});

test("null when nothing has been built", () => {
  const root = project("no-build", { "src/main.ts": "console.log(1)" });
  assert.equal(distFiles.findDistDir(root), null);
});

// ---------------------------------------------------------------------------
// collectDistFiles
// ---------------------------------------------------------------------------

test("collects text verbatim and binary as base64", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  const root = project("bundle", {
    "dist/index.html": "<html><script src=\"/assets/index-abc.js\"></script></html>",
    "dist/assets/index-abc.js": "console.log('app')",
  });
  fs.writeFileSync(path.join(root, "dist/assets/logo.png"), png);

  const res = distFiles.collectDistFiles(path.join(root, "dist"));
  assert.equal(res.ok, true);

  const byPath = Object.fromEntries(res.files.map((f) => [f.path, f]));
  assert.equal(byPath["index.html"].encoding, null);
  assert.match(byPath["index.html"].content, /assets\/index-abc\.js/);
  assert.equal(byPath["assets/index-abc.js"].encoding, null);
  assert.equal(byPath["assets/logo.png"].encoding, "base64");
  assert.deepEqual(Buffer.from(byPath["assets/logo.png"].content, "base64"), png);
});

test("skips dotfiles and node_modules even at a project root", () => {
  const root = project("rooted", {
    "index.html": "<html>site</html>",
    ".DS_Store": "junk",
    "node_modules/pkg/index.js": "module.exports = 1",
  });
  const res = distFiles.collectDistFiles(root);
  assert.equal(res.ok, true);
  const paths = res.files.map((f) => f.path);
  assert.deepEqual(paths, ["index.html"]);
});

test("refuses output with no root index.html", () => {
  const root = project("headless", { "dist/assets/app.js": "console.log(1)" });
  const res = distFiles.collectDistFiles(path.join(root, "dist"));
  assert.equal(res.ok, false);
  assert.equal(res.error, "no_entry");
});

// ---------------------------------------------------------------------------
// Install marker
// ---------------------------------------------------------------------------

test("marker round-trips the installed app id", () => {
  const root = project("marked", { "dist/index.html": "<html></html>" });
  assert.equal(distFiles.readInstalledAppId(root), null);
  assert.equal(distFiles.writeInstalledAppId(root, "nook-a1b2"), true);
  assert.equal(distFiles.readInstalledAppId(root), "nook-a1b2");
});
