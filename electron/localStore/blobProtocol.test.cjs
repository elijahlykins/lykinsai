// Run: node --test electron/localStore/blobProtocol.test.cjs
//
// The handler is exercised directly with plain Requests rather than through
// Electron, because what can actually go wrong here is HTTP semantics and path
// safety, not the binding. Range handling in particular has to be right or
// video will not scrub, and the escape check is the only thing standing
// between a remote-origin renderer and the filesystem.

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localStore = require("./index.cjs");
const blobs = require("./blobs.cjs");
const protocol = require("./blobProtocol.cjs");

let userDataPath;
const BODY = Buffer.from("0123456789abcdefghij"); // 20 bytes, easy to slice

before(async () => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-blobproto-"));
  localStore.configure(userDataPath);
  await blobs.write("item-1", BODY, { filename: "clip.mp4", variant: "original" });
  await blobs.write("item-1", Buffer.from("thumb"), { filename: "t.jpg", variant: "thumb" });
});

after(() => {
  localStore.shutdown();
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

const get = (url, headers = {}) => protocol.handleRequest(new Request(url, { headers }));
const urlFor = (p) => protocol.urlFor(p);

describe("URL round trip", () => {
  test("builds and parses back the same stored path", () => {
    const url = urlFor("item-1/original.mp4");
    assert.equal(url, "lykn-blob://blob/item-1/original.mp4");
    assert.equal(protocol.pathFromUrl(url), "item-1/original.mp4");
  });

  test("survives characters that need escaping", () => {
    const url = urlFor("item 1/my file.png");
    assert.equal(protocol.pathFromUrl(url), "item 1/my file.png");
  });

  test("ignores URLs belonging to another scheme", () => {
    assert.equal(protocol.pathFromUrl("https://example.com/a.png"), null);
    assert.equal(protocol.pathFromUrl("not a url"), null);
  });
});

describe("serving files", () => {
  test("returns the whole file with the right type", async () => {
    const res = await get(urlFor("item-1/original.mp4"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(res.headers.get("content-length"), String(BODY.length));
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), BODY.toString());
  });

  test("picks the content type from the extension", async () => {
    const res = await get(urlFor("item-1/thumb.jpg"));
    assert.equal(res.headers.get("content-type"), "image/jpeg");
  });

  test("caches hard, because a given path's bytes never change", async () => {
    const res = await get(urlFor("item-1/original.mp4"));
    assert.match(res.headers.get("cache-control"), /immutable/);
  });

  test("404s a path with no file behind it", async () => {
    const res = await get(urlFor("item-1/nothing.png"));
    assert.equal(res.status, 404);
  });

  test("400s a malformed URL", async () => {
    const res = await protocol.handleRequest({ url: "lykn-blob://blob/" });
    assert.equal(res.status, 400);
  });
});

describe("range requests", () => {
  test("serves a byte range as 206 with the right slice", async () => {
    const res = await get(urlFor("item-1/original.mp4"), { Range: "bytes=5-9" });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 5-9/${BODY.length}`);
    assert.equal(res.headers.get("content-length"), "5");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "56789");
  });

  test("treats an open-ended range as 'to the end'", async () => {
    const res = await get(urlFor("item-1/original.mp4"), { Range: "bytes=15-" });
    assert.equal(res.status, 206);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "fghij");
  });

  test("handles the suffix form browsers use to read trailing metadata", async () => {
    // MP4 players routinely ask for the last few bytes to find the moov atom.
    const res = await get(urlFor("item-1/original.mp4"), { Range: "bytes=-4" });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 16-19/${BODY.length}`);
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "ghij");
  });

  test("clamps a range that runs past the end", async () => {
    const res = await get(urlFor("item-1/original.mp4"), { Range: "bytes=18-999" });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 18-19/${BODY.length}`);
  });

  test("416s a range that starts past the end", async () => {
    const res = await get(urlFor("item-1/original.mp4"), { Range: "bytes=999-" });
    assert.equal(res.status, 416);
    assert.equal(res.headers.get("content-range"), `bytes */${BODY.length}`);
  });

  test("416s rather than silently sending everything when the range is nonsense", async () => {
    // Quietly returning 200 here is what makes a video look unseekable.
    const res = await get(urlFor("item-1/original.mp4"), { Range: "bytes=abc" });
    assert.equal(res.status, 416);
  });

  test("parseRange agrees with the responses", () => {
    assert.deepEqual(protocol.parseRange("bytes=0-9", 20), { start: 0, end: 9 });
    assert.deepEqual(protocol.parseRange("bytes=-5", 20), { start: 15, end: 19 });
    assert.equal(protocol.parseRange("bytes=20-", 20), null);
    assert.equal(protocol.parseRange("", 20), null);
  });
});

describe("path safety", () => {
  test("refuses to climb out of the blobs directory", async () => {
    // The renderer loads a remote origin, so a crafted URL is a real threat,
    // not a hypothetical one.
    for (const attempt of [
      "../../../../etc/passwd",
      "item-1/../../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
    ]) {
      const res = await protocol.handleRequest({
        url: `lykn-blob://blob/${attempt.split("/").map(encodeURIComponent).join("/")}`,
      });
      assert.ok(
        res.status === 403 || res.status === 404,
        `${attempt} should be refused, got ${res.status}`,
      );
    }
  });

  test("an absolute path does not escape either", async () => {
    const res = await protocol.handleRequest({ url: "lykn-blob://blob//etc/passwd" });
    assert.ok(res.status === 403 || res.status === 404);
  });
});
