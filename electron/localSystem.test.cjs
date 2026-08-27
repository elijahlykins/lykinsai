/**
 * The per-folder sync switch, which is the only part of Local Mode a user can
 * flip from inside a folder rather than from Settings.
 *
 * What's worth pinning down isn't the file writing — it's that a folder ends up
 * readable exactly when its switch says so, under both ways of sharing a Mac
 * (the whole home folder, or a hand-picked list), and that flipping the switch
 * back returns things to where they were.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localSystem = require("./localSystem.cjs");

let userData;
let home;
let desktop;

function write(config) {
  fs.writeFileSync(
    path.join(userData, "local-mode.json"),
    JSON.stringify({ enabled: true, ...config }),
  );
}

function allows(target) {
  return localSystem.isAllowedPath(target, localSystem.readLocalMode(userData));
}

function toggle(folder, synced) {
  localSystem.writeFolderSync(userData, { folder, synced });
}

test.beforeEach(() => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-sync-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-home-"));
  desktop = path.join(home, "Desktop");
  fs.mkdirSync(desktop);
});

test("a shared Mac reads everything until a folder is switched off", () => {
  write({ syncAll: true, syncedFolders: [] });
  assert.equal(allows(desktop), true);

  toggle(desktop, false);
  assert.equal(allows(desktop), false);
  assert.equal(allows(path.join(desktop, "notes.txt")), false);
  // Only that folder: its neighbours are untouched.
  assert.equal(allows(home), true);
});

test("switching a folder back on restores it", () => {
  write({ syncAll: true, syncedFolders: [] });

  toggle(desktop, false);
  toggle(desktop, true);

  assert.equal(allows(desktop), true);
  assert.deepEqual(localSystem.readLocalMode(userData).excludedFolders, []);
});

test("switching on a folder outside a hand-picked list adds it", () => {
  const projects = path.join(home, "Projects");
  fs.mkdirSync(projects);
  write({ syncAll: false, syncedFolders: [projects] });
  assert.equal(allows(desktop), false);

  toggle(desktop, true);

  assert.equal(allows(desktop), true);
  assert.deepEqual(localSystem.readLocalMode(userData).syncedFolders, [projects, desktop]);
});

test("a folder switched off stays on the list so it can come back", () => {
  write({ syncAll: false, syncedFolders: [desktop] });

  toggle(desktop, false);
  assert.equal(allows(desktop), false);
  // Still shared on paper — that's what the sidebar lists and what turning the
  // switch back on returns to.
  assert.deepEqual(localSystem.readLocalMode(userData).syncedFolders, [desktop]);

  toggle(desktop, true);
  assert.equal(allows(desktop), true);
});

test("the more specific switch wins", () => {
  write({ syncAll: true, syncedFolders: [] });

  toggle(home, false);
  assert.equal(allows(desktop), false);

  toggle(desktop, true);
  assert.equal(allows(desktop), true);
  assert.equal(allows(path.join(desktop, "shot.png")), true);
  assert.equal(allows(path.join(home, "Documents")), false);
});

test("switching a parent on leaves a child's own switch off", () => {
  write({ syncAll: true, syncedFolders: [] });

  toggle(desktop, false);
  toggle(home, false);
  toggle(home, true);

  assert.equal(allows(home), true);
  assert.equal(allows(desktop), false);
});

test("the AI's file tools are blocked by a switched-off folder", () => {
  write({ syncAll: true, syncedFolders: [] });
  toggle(desktop, false);

  const config = localSystem.readLocalMode(userData);
  assert.equal(localSystem.isAllowedPath(desktop, config), false);

  const listed = localSystem.run("local_list_dir", { path: desktop }, { userDataPath: userData });
  return listed.then((result) => {
    assert.equal(result.ok, false);
    assert.match(result.error, /not synced/i);
  });
});

test("the AI can validate folders and files for normal opening", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const folder = path.join(desktop, "Brand Assets");
  const file = path.join(folder, "logo.svg");
  fs.mkdirSync(folder);
  fs.writeFileSync(file, "<svg/>");

  const openedFolder = await localSystem.run(
    "local_open_path",
    { path: folder },
    { userDataPath: userData },
  );
  assert.equal(openedFolder.ok, true);
  assert.equal(openedFolder.type, "dir");
  assert.equal(openedFolder.path, folder);

  const openedFile = await localSystem.run(
    "local_open_path",
    { path: file },
    { userDataPath: userData },
  );
  assert.equal(openedFile.ok, true);
  assert.equal(openedFile.type, "file");
  assert.equal(openedFile.parent, folder);
});

test("the AI can find a folder by name before opening it", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const folder = path.join(desktop, "Brand Assets");
  fs.mkdirSync(folder);

  const result = await localSystem.run(
    "local_search_files",
    { path: desktop, namePattern: "*brand assets*" },
    { userDataPath: userData },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{ path: folder, type: "dir" }]);
});

test("the AI cannot open a missing path", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const result = await localSystem.run(
    "local_open_path",
    { path: path.join(desktop, "Missing") },
    { userDataPath: userData },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /no such file/i);
});

test("editing a file asks for approval, then swaps only the matched snippet", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const file = path.join(desktop, "notes.md");
  fs.writeFileSync(file, "# Plan\n- buy milk\n- walk dog\n");

  const pending = await localSystem.run(
    "local_edit_file",
    { path: file, oldText: "- buy milk", newText: "- buy oat milk" },
    { userDataPath: userData },
  );
  assert.equal(pending.needsApproval, true);
  assert.match(pending.summary, /Edit file: /);

  const done = await localSystem.run(
    "local_edit_file",
    { path: file, oldText: "- buy milk", newText: "- buy oat milk" },
    { userDataPath: userData, approved: true },
  );
  assert.equal(done.ok, true);
  assert.equal(done.replacements, 1);
  assert.equal(fs.readFileSync(file, "utf8"), "# Plan\n- buy oat milk\n- walk dog\n");
});

test("an edit whose snippet isn't in the file changes nothing", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const file = path.join(desktop, "notes.md");
  fs.writeFileSync(file, "hello world\n");

  const result = await localSystem.run(
    "local_edit_file",
    { path: file, oldText: "goodbye", newText: "hi" },
    { userDataPath: userData, approved: true },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
  assert.equal(fs.readFileSync(file, "utf8"), "hello world\n");
});

test("an ambiguous snippet is refused unless replaceAll is set", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const file = path.join(desktop, "notes.md");
  fs.writeFileSync(file, "a\nTODO\nb\nTODO\n");

  const refused = await localSystem.run(
    "local_edit_file",
    { path: file, oldText: "TODO", newText: "DONE" },
    { userDataPath: userData, approved: true },
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /2 times/);

  const all = await localSystem.run(
    "local_edit_file",
    { path: file, oldText: "TODO", newText: "DONE", replaceAll: true },
    { userDataPath: userData, approved: true },
  );
  assert.equal(all.ok, true);
  assert.equal(all.replacements, 2);
  assert.equal(fs.readFileSync(file, "utf8"), "a\nDONE\nb\nDONE\n");
});

test("editing a missing file points at local_write_file instead", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const result = await localSystem.run(
    "local_edit_file",
    { path: path.join(desktop, "nope.txt"), oldText: "x", newText: "y" },
    { userDataPath: userData, approved: true },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /does not exist.*local_write_file/i);
});

test("edits are blocked outside the synced folders", async () => {
  const projects = path.join(home, "Projects");
  fs.mkdirSync(projects);
  write({ syncAll: false, syncedFolders: [projects] });
  const file = path.join(desktop, "notes.md");
  fs.writeFileSync(file, "hello\n");

  const result = await localSystem.run(
    "local_edit_file",
    { path: file, oldText: "hello", newText: "bye" },
    { userDataPath: userData, approved: true },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not synced/i);
  assert.equal(fs.readFileSync(file, "utf8"), "hello\n");
});

test("switching a folder keeps the rest of the settings", () => {
  write({ syncAll: false, syncedFolders: [home], updatedAt: 1 });

  toggle(desktop, false);

  const config = localSystem.readLocalMode(userData);
  assert.equal(config.enabled, true);
  assert.equal(config.syncAll, false);
  assert.deepEqual(config.syncedFolders, [home]);
});

test("a traversal out of a synced folder is rejected", async () => {
  write({ syncAll: false, syncedFolders: [desktop] });
  const secret = path.join(home, "secret.txt");
  fs.writeFileSync(secret, "private\n");
  const result = await localSystem.run(
    "local_read_file",
    { path: path.join(desktop, "..", "secret.txt") },
    { userDataPath: userData },
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not synced/i);
});

test("abort kills the shell process group, not only zsh", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const marker = path.join(userData, "grandchild-still-running");
  const controller = new AbortController();
  const pending = localSystem.run(
    "local_run_command",
    { command: `(sleep 20; touch "${marker}") & echo $!` },
    { userDataPath: userData, approved: true, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.abort();
  await pending;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(fs.existsSync(marker), false);
});

test("an aborted shell command is killed instead of running to timeout", async () => {
  write({ syncAll: true, syncedFolders: [] });
  const controller = new AbortController();
  const started = Date.now();
  const pending = localSystem.run(
    "local_run_command",
    { command: "sleep 30" },
    { userDataPath: userData, approved: true, signal: controller.signal },
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  controller.abort();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(String(result.error || ""), /aborted/i);
  assert.ok(Date.now() - started < 5000);
});
