/**
 * Files browser backend — exercised against a real temp filesystem, because
 * the whole point of these operations is what they do to files on disk.
 *
 * Trashing is the one thing not covered: shell.trashItem needs a running
 * Electron app, and faking it would only test the fake.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const macFiles = require("./macFiles.cjs");

let root;
let userData;

/** Point the allowlist at a scratch directory and nothing else. */
function setLocalMode({
  enabled = true,
  syncAll = false,
  syncedFolders = [root],
  excludedFolders = [],
} = {}) {
  fs.writeFileSync(
    path.join(userData, "local-mode.json"),
    JSON.stringify({ enabled, syncAll, syncedFolders, excludedFolders, updatedAt: Date.now() }),
  );
}

test.beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-files-"));
  root = path.join(base, "root");
  userData = path.join(base, "userData");
  fs.mkdirSync(root);
  fs.mkdirSync(userData);
  macFiles.configure({ userDataPath: userData, onChange: () => {} });
  setLocalMode();
});

test.afterEach(() => {
  macFiles.closeWatchers();
});

// --- Listing ---------------------------------------------------------------

test("lists a directory with folders first and kind metadata", async () => {
  fs.writeFileSync(path.join(root, "notes.txt"), "hello");
  fs.mkdirSync(path.join(root, "Projects"));

  const result = await macFiles.list({ path: root });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.entries.map((e) => e.name),
    ["Projects", "notes.txt"],
  );
  assert.equal(result.entries[0].type, "dir");
  assert.equal(result.entries[1].ext, "txt");
  assert.equal(result.entries[1].size, 5);
  assert.equal(result.total, 2);
});

test("hides dotfiles unless asked for them", async () => {
  fs.writeFileSync(path.join(root, ".secret"), "x");
  fs.writeFileSync(path.join(root, "visible.txt"), "x");

  const hidden = await macFiles.list({ path: root });
  assert.deepEqual(hidden.entries.map((e) => e.name), ["visible.txt"]);

  const shown = await macFiles.list({ path: root, showHidden: true });
  assert.deepEqual(shown.entries.map((e) => e.name), [".secret", "visible.txt"]);
  assert.equal(shown.entries[0].hidden, true);
});

test("sorts by size and reverses on demand", async () => {
  fs.writeFileSync(path.join(root, "small.txt"), "a");
  fs.writeFileSync(path.join(root, "big.txt"), "a".repeat(100));

  const asc = await macFiles.list({ path: root, sort: "size" });
  assert.deepEqual(asc.entries.map((e) => e.name), ["small.txt", "big.txt"]);

  const desc = await macFiles.list({ path: root, sort: "size", order: "desc" });
  assert.deepEqual(desc.entries.map((e) => e.name), ["big.txt", "small.txt"]);
});

test("treats an .app bundle as a package rather than a folder", async () => {
  fs.mkdirSync(path.join(root, "Thing.app"));

  const result = await macFiles.list({ path: root });

  assert.equal(result.entries[0].package, true);
  assert.equal(result.entries[0].type, "dir");
});

// --- Thumbnails ------------------------------------------------------------
//
// Generating one needs Electron's QuickLook bridge, so these cover the
// decisions made before that point — which is also everything that could let
// a caller read outside the allowlist.

test("does not thumbnail a plain folder", async () => {
  fs.mkdirSync(path.join(root, "Projects"));

  const result = await macFiles.thumbnail({ path: path.join(root, "Projects") });

  assert.equal(result.ok, false);
  assert.equal(result.error, "no_thumbnail");
});

test("reports a missing file rather than throwing", async () => {
  const result = await macFiles.thumbnail({ path: path.join(root, "ghost.pdf") });

  assert.equal(result.ok, false);
  assert.equal(result.error, "not_found");
});

test("refuses to thumbnail outside the synced folders", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));
  fs.writeFileSync(path.join(outside, "private.pdf"), "x");

  const result = await macFiles.thumbnail({ path: path.join(outside, "private.pdf") });

  assert.equal(result.ok, false);
  assert.equal(result.error, "not_synced");
});

test("refuses to thumbnail when Local Mode is off", async () => {
  fs.writeFileSync(path.join(root, "doc.pdf"), "x");
  setLocalMode({ enabled: false });

  const result = await macFiles.thumbnail({ path: path.join(root, "doc.pdf") });

  assert.equal(result.ok, false);
  assert.equal(result.error, "local_mode_off");
});

// --- Access boundary -------------------------------------------------------

test("refuses paths outside the synced folders", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));

  const result = await macFiles.list({ path: outside });

  assert.equal(result.ok, false);
  assert.equal(result.error, "not_synced");
});

test("whole-home share allows the home folder and refuses the rest of the disk", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));
  setLocalMode({ syncAll: true, syncedFolders: [] });

  const homeList = await macFiles.list({ path: os.homedir() });
  assert.equal(homeList.ok, true);
  const result = await macFiles.list({ path: outside });
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_synced");
});

test("refuses a folder whose own sync switch is off", async () => {
  const off = path.join(root, "Private");
  fs.mkdirSync(off);
  fs.writeFileSync(path.join(off, "diary.txt"), "x");
  setLocalMode({ syncAll: true, syncedFolders: [root], excludedFolders: [off] });

  assert.equal((await macFiles.list({ path: off })).error, "not_synced");
  // The exclusion covers what's inside it, not its neighbours.
  assert.equal((await macFiles.list({ path: root })).ok, true);
  assert.equal((await macFiles.thumbnail({ path: path.join(off, "diary.txt") })).error, "not_synced");
});

test("lets a folder switched back on override an excluded parent", async () => {
  const child = path.join(root, "Shared");
  fs.mkdirSync(child);
  setLocalMode({ syncAll: true, syncedFolders: [child], excludedFolders: [root] });

  assert.equal((await macFiles.list({ path: child })).ok, true);
  assert.equal((await macFiles.list({ path: root })).error, "not_synced");
});

test("refuses everything when Local Mode is off", async () => {
  setLocalMode({ enabled: false });

  assert.equal((await macFiles.list({ path: root })).error, "local_mode_off");
  assert.equal((await macFiles.mkdir({ path: root })).error, "local_mode_off");
});

// --- Mutations -------------------------------------------------------------

test("creates a folder and disambiguates a repeat name", async () => {
  const first = await macFiles.mkdir({ path: root, name: "Ideas" });
  const second = await macFiles.mkdir({ path: root, name: "Ideas" });

  assert.equal(first.name, "Ideas");
  assert.equal(second.name, "Ideas 2");
  assert.ok(fs.existsSync(path.join(root, "Ideas 2")));
});

test("rejects names that would escape the folder", async () => {
  assert.equal((await macFiles.mkdir({ path: root, name: "../evil" })).error, "illegal_name");
  assert.equal((await macFiles.mkdir({ path: root, name: "a/b" })).error, "illegal_name");
  assert.equal(
    (await macFiles.rename({ path: path.join(root, "x"), name: ".." })).error,
    "reserved_name",
  );
});

test("falls back to an untitled name when none is given", async () => {
  // The New Folder button sends no name at all, so blank has to mean default
  // rather than error.
  assert.equal((await macFiles.mkdir({ path: root })).name, "untitled folder");
  assert.equal((await macFiles.mkdir({ path: root, name: "   " })).name, "untitled folder 2");
});

test("renames a file and refuses to clobber an existing name", async () => {
  fs.writeFileSync(path.join(root, "draft.txt"), "x");
  fs.writeFileSync(path.join(root, "taken.txt"), "x");

  const ok = await macFiles.rename({ path: path.join(root, "draft.txt"), name: "final.txt" });
  assert.equal(ok.ok, true);
  assert.ok(fs.existsSync(path.join(root, "final.txt")));

  const clash = await macFiles.rename({ path: path.join(root, "final.txt"), name: "taken.txt" });
  assert.equal(clash.error, "name_taken");
});

test("moves files into a folder", async () => {
  fs.writeFileSync(path.join(root, "a.txt"), "x");
  fs.writeFileSync(path.join(root, "b.txt"), "x");
  const dest = path.join(root, "Archive");
  fs.mkdirSync(dest);

  const result = await macFiles.move({
    paths: [path.join(root, "a.txt"), path.join(root, "b.txt")],
    dest,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(fs.readdirSync(dest).sort(), ["a.txt", "b.txt"]);
  assert.equal(fs.existsSync(path.join(root, "a.txt")), false);
});

test("will not move a folder inside itself", async () => {
  const folder = path.join(root, "Loop");
  fs.mkdirSync(folder);
  fs.mkdirSync(path.join(folder, "child"));

  const result = await macFiles.move({ paths: [folder], dest: path.join(folder, "child") });

  assert.equal(result.ok, false);
  assert.equal(result.failed[0].error, "into_itself");
  assert.ok(fs.existsSync(folder));
});

test("copies a folder tree without touching the original", async () => {
  const source = path.join(root, "Source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "inner.txt"), "hello");
  const dest = path.join(root, "Dest");
  fs.mkdirSync(dest);

  const result = await macFiles.copy({ paths: [source], dest });

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(dest, "Source", "inner.txt"), "utf8"), "hello");
  assert.ok(fs.existsSync(path.join(source, "inner.txt")));
});

test("duplicates using Finder's copy naming", async () => {
  fs.writeFileSync(path.join(root, "report.pdf"), "x");

  await macFiles.duplicate({ paths: [path.join(root, "report.pdf")] });
  await macFiles.duplicate({ paths: [path.join(root, "report.pdf")] });

  assert.ok(fs.existsSync(path.join(root, "report copy.pdf")));
  assert.ok(fs.existsSync(path.join(root, "report copy 2.pdf")));
});

test("refuses to move files out to an unshared folder", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));
  fs.writeFileSync(path.join(root, "a.txt"), "x");

  const result = await macFiles.move({ paths: [path.join(root, "a.txt")], dest: outside });

  assert.equal(result.ok, false);
  assert.equal(result.error, "not_synced");
  assert.ok(fs.existsSync(path.join(root, "a.txt")));
});

// --- Roots -----------------------------------------------------------------

test("offers the shared folders as their own sidebar section", async () => {
  const roots = await macFiles.roots();

  assert.equal(roots.ok, true);
  assert.equal(roots.syncAll, false);
  assert.deepEqual(roots.synced.map((s) => s.path), [root]);
  assert.equal(roots.synced[0].synced, true);
  // Home isn't inside the scratch folder, so it's listed with sync off — that
  // page is where the user turns it on.
  assert.equal(roots.favorites.find((f) => f.id === "home").synced, false);
});

test("offers the standard favorites when the whole Mac is shared", async () => {
  setLocalMode({ syncAll: true, syncedFolders: [] });

  const roots = await macFiles.roots();

  assert.equal(roots.syncAll, true);
  assert.equal(roots.favorites.find((f) => f.id === "home").synced, true);
  assert.equal(roots.synced.length, 0);
});

test("marks a favorite whose sync was switched off", async () => {
  setLocalMode({ syncAll: true, syncedFolders: [], excludedFolders: [os.homedir()] });

  const roots = await macFiles.roots();

  const home = roots.favorites.find((f) => f.id === "home");
  assert.equal(home.synced, false);
  // Still listed, or there'd be nowhere to switch it back on.
  assert.equal(home.path, os.homedir());
});

test("keeps a switched-off shared folder in the sidebar", async () => {
  setLocalMode({ syncedFolders: [root], excludedFolders: [root] });

  const roots = await macFiles.roots();

  assert.deepEqual(roots.synced.map((s) => s.path), [root]);
  assert.equal(roots.synced[0].synced, false);
});

// --- Watching --------------------------------------------------------------

test("reports a change when the watched folder gains a file", async () => {
  const seen = [];
  macFiles.configure({ userDataPath: userData, onChange: (p) => seen.push(p) });

  assert.equal((await macFiles.watch({ path: root })).ok, true);
  await fsp.writeFile(path.join(root, "new.txt"), "x");
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(seen.includes(root), `expected a change for ${root}, saw ${JSON.stringify(seen)}`);
});

test("keeps watching until the last viewer leaves", async () => {
  await macFiles.watch({ path: root });
  await macFiles.watch({ path: root });

  await macFiles.unwatch({ path: root });
  const seen = [];
  macFiles.configure({ userDataPath: userData, onChange: (p) => seen.push(p) });
  await fsp.writeFile(path.join(root, "still-watched.txt"), "x");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(seen.includes(root), "one unwatch should not have stopped the watcher");

  await macFiles.unwatch({ path: root });
  seen.length = 0;
  await fsp.writeFile(path.join(root, "after-close.txt"), "x");
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(seen, []);
});
