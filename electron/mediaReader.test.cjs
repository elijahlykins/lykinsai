const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const mediaReader = require("./mediaReader.cjs");
const localSystem = require("./localSystem.cjs");

// 1×1 PNG (red pixel). Small enough that the raw-bytes preview fallback works
// without Electron, sips, or ffmpeg.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir;

test.beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-media-"));
  fs.writeFileSync(
    path.join(dir, "local-mode.json"),
    JSON.stringify({
      enabled: true,
      syncAll: false,
      syncedFolders: [dir],
      excludedFolders: [],
      updatedAt: Date.now(),
    }),
  );
  mediaReader.clearMediaCache();
  localSystem.configure(dir);
  localSystem.configureExtraction();
});

function pngPath(name = "shot.png") {
  const file = path.join(dir, name);
  fs.writeFileSync(file, TINY_PNG);
  return file;
}

function mockDescribeFetch(json = { description: "A red pixel on a white field.", visibleText: "" }) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    assert.match(String(url), /\/api\/desktop\/agent-model$/);
    assert.equal(body.stage, "describe");
    assert.ok(String(body.imageUrl || "").startsWith("data:image/"));
    return {
      ok: true,
      json: async () => ({ ok: true, json, model: "test-vision" }),
    };
  };
}

test("isReadableMediaPath covers screenshots and recordings, not documents", () => {
  assert.equal(mediaReader.isReadableMediaPath("~/Desktop/shot.png"), true);
  assert.equal(mediaReader.isReadableMediaPath("clip.mov"), true);
  assert.equal(mediaReader.isReadableMediaPath("notes.pdf"), false);
  assert.equal(mediaReader.isReadableMediaPath("code.js"), false);
});

test("describeMediaFile returns a vision description instead of refusing the PNG", async () => {
  const file = pngPath("Screenshot 1.png");
  const out = await mediaReader.describeMediaFile(file, {
    apiBase: "https://example.test",
    token: "tok",
    fetchImpl: mockDescribeFetch({
      description: "The overlay chat bar with Cody selected.",
      visibleText: "Ask Cody",
    }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.kind, "image");
  assert.equal(out.vision, true);
  assert.match(out.content, /Screenshot 1\.png/);
  assert.match(out.content, /Ask Cody/);
  assert.match(out.content, /overlay chat bar/);
  assert.ok(String(out.imageDataUrl || "").startsWith("data:image/"));
});

test("describeMediaFile still returns the file when vision is unavailable", async () => {
  const file = pngPath();
  const out = await mediaReader.describeMediaFile(file, {});
  assert.equal(out.ok, true);
  assert.equal(out.vision, false);
  assert.match(out.content, /Not signed in|pixels could not/);
  assert.doesNotMatch(out.content || "", /binary file/i);
});

test("local_read_file looks at a PNG instead of calling it binary", async () => {
  const file = pngPath("screen.png");
  localSystem.configureExtraction({
    apiBase: "https://example.test",
    getAuthToken: async () => "tok",
    fetchImpl: mockDescribeFetch({
      description: "Four screenshot tiles in a Finder window.",
      visibleText: "Screenshots:recording",
    }),
  });
  const out = await localSystem.run("local_read_file", { path: file }, { userDataPath: dir });
  assert.equal(out.ok, true);
  assert.equal(out.kind, "image");
  assert.match(out.content, /Four screenshot tiles/);
  assert.match(out.content, /Screenshots:recording/);
  assert.doesNotMatch(String(out.error || ""), /binary file/i);
});
