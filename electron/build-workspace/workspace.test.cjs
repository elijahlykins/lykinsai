/**
 * The Build workspace's one security-critical promise: containment checks are
 * exact. Everything under ~/LYKN/Builds is the agent's own area; nothing
 * outside it — including lookalike siblings and symlink escapes — may ever
 * classify as workspace.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const workspace = require("./workspace.cjs");

let root;

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-builds-"));
  process.env.LYKN_BUILDS_DIR = root;
});

test.afterEach(() => {
  delete process.env.LYKN_BUILDS_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

test("the root and anything inside it are workspace paths", () => {
  workspace.ensureWorkspaceRoot();
  assert.equal(workspace.isWorkspacePath(root), true);
  assert.equal(workspace.isWorkspacePath(path.join(root, "my-game")), true);
  assert.equal(workspace.isWorkspacePath(path.join(root, "a", "b", "deep.txt")), true);
});

test("siblings and lookalike prefixes are not workspace paths", () => {
  assert.equal(workspace.isWorkspacePath(os.tmpdir()), false);
  assert.equal(workspace.isWorkspacePath(`${root}-evil`), false);
  assert.equal(workspace.isWorkspacePath(path.join(root, "..", "other")), false);
});

test("a symlink inside the workspace cannot escape it", () => {
  workspace.ensureWorkspaceRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-outside-"));
  const link = path.join(root, "sneaky");
  fs.symlinkSync(outside, link);
  try {
    assert.equal(workspace.isWorkspacePath(link), false);
    assert.equal(workspace.isWorkspacePath(path.join(link, "victim.txt")), false);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("ensureWorkspaceRoot creates the root and the logs dir", () => {
  fs.rmSync(root, { recursive: true, force: true });
  const created = workspace.ensureWorkspaceRoot();
  assert.equal(created, root);
  assert.equal(fs.existsSync(path.join(root, ".lykn", "logs")), true);
});

test("listProjects returns visible project folders, newest first", async () => {
  workspace.ensureWorkspaceRoot();
  fs.mkdirSync(path.join(root, "older-project"));
  fs.writeFileSync(path.join(root, "loose-file.txt"), "not a project");
  await new Promise((r) => setTimeout(r, 20));
  fs.mkdirSync(path.join(root, "newer-project"));

  const projects = await workspace.listProjects();
  const names = projects.map((p) => p.name);
  assert.deepEqual(names, ["newer-project", "older-project"]);
  // Dot-dirs (.lykn) and plain files never appear.
  assert.equal(names.includes(".lykn"), false);
  assert.equal(names.includes("loose-file.txt"), false);
});
