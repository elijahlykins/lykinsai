/**
 * lykn-mac:// — the scheme that lets LYKN render files from this Mac.
 *
 * The renderer loads a remote origin and composes these URLs itself, so the
 * handler is the only thing standing between a crafted URL and the disk. Most
 * of what follows is that boundary.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const protocol = require("./macFileProtocol.cjs");
const macFiles = require("./macFiles.cjs");

let root;
let userData;

function setLocalMode({ enabled = true, syncAll = false, syncedFolders = [root] } = {}) {
  fs.writeFileSync(
    path.join(userData, "local-mode.json"),
    JSON.stringify({ enabled, syncAll, syncedFolders, updatedAt: Date.now() }),
  );
}

test.beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-macproto-"));
  root = path.join(base, "root");
  userData = path.join(base, "userData");
  fs.mkdirSync(root);
  fs.mkdirSync(userData);
  macFiles.configure({ userDataPath: userData, onChange: () => {} });
  setLocalMode();
});

const get = (url, headers = {}) => protocol.handleRequest(new Request(url, { headers }));

test("round-trips an absolute path through the URL", () => {
  const target = "/Users/me/My Photos/a b.png";
  assert.equal(protocol.pathFromUrl(protocol.urlFor(target)), target);
});

test("serves a file inside a shared folder", async () => {
  const file = path.join(root, "hello.txt");
  fs.writeFileSync(file, "hello world");

  const res = await get(protocol.urlFor(file));

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/plain/);
  assert.equal(await res.text(), "hello world");
});

test("serves a byte range so video can seek", async () => {
  const file = path.join(root, "clip.mp4");
  fs.writeFileSync(file, "0123456789");

  const res = await get(protocol.urlFor(file), { range: "bytes=2-5" });

  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await res.text(), "2345");
});

test("refuses a file outside the shared folders", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));
  const file = path.join(outside, "private.txt");
  fs.writeFileSync(file, "secret");

  const res = await get(protocol.urlFor(file));

  assert.equal(res.status, 403);
});

test("refuses everything when Local Mode is off", async () => {
  const file = path.join(root, "hello.txt");
  fs.writeFileSync(file, "hello");
  setLocalMode({ enabled: false });

  assert.equal((await get(protocol.urlFor(file))).status, 403);
});

test("serves anything readable when the whole Mac is shared", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));
  const file = path.join(outside, "ok.txt");
  fs.writeFileSync(file, "fine");
  setLocalMode({ syncAll: true, syncedFolders: [] });

  const res = await get(protocol.urlFor(file));

  assert.equal(res.status, 200);
});

test("a traversal out of a shared folder is still checked against the allowlist", async () => {
  // Resolving happens before the allowlist check, so climbing out of the
  // shared root lands on a path the allowlist rejects rather than one it
  // never sees.
  for (const attempt of [
    `${root}/../../../etc/passwd`,
    `${root}/./../../etc/hosts`,
  ]) {
    const res = await protocol.handleRequest({
      url: `lykn-mac://file/${attempt.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/")}`,
    });
    assert.equal(res.status, 403, `expected 403 for ${attempt}`);
  }
});

test("404s a directory and a missing file", async () => {
  assert.equal((await get(protocol.urlFor(root))).status, 404);
  assert.equal((await get(protocol.urlFor(path.join(root, "nope.txt")))).status, 404);
});

test("400s a malformed URL", async () => {
  const res = await protocol.handleRequest({ url: "lykn-mac://file/" });
  assert.equal(res.status, 400);
});

test("does not cache, because a file on disk can change in place", async () => {
  const file = path.join(root, "notes.txt");
  fs.writeFileSync(file, "v1");

  const res = await get(protocol.urlFor(file));

  assert.equal(res.headers.get("cache-control"), "no-cache");
});
