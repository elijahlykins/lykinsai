/**
 * The workspace-only session contract: with Local Mode OFF, the Build agent
 * gets full, frictionless capability inside ~/LYKN/Builds and exactly nothing
 * anywhere else. These tests drive localSystem.run the way the IPC gate does
 * (workspaceOnly: true) and pin both halves of that promise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localSystem = require("../localSystem.cjs");

let root;
let userData;

function run(name, args, opts = {}) {
  return localSystem.run(name, args, {
    userDataPath: userData,
    workspaceOnly: true,
    ...opts,
  });
}

test.beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-builds-"));
  userData = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-user-"));
  process.env.LYKN_BUILDS_DIR = root;
  // Local Mode is OFF — the whole point of workspace-only sessions.
  fs.writeFileSync(
    path.join(userData, "local-mode.json"),
    JSON.stringify({ enabled: false, syncAll: false, syncedFolders: [] }),
  );
});

test.afterEach(() => {
  delete process.env.LYKN_BUILDS_DIR;
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
});

test("local_build_workspace creates the root and lists projects", async () => {
  fs.rmSync(root, { recursive: true, force: true });
  const res = await run("local_build_workspace", {});
  assert.equal(res.ok, true);
  assert.equal(res.root, root);
  assert.deepEqual(res.projects, []);
  assert.equal(fs.existsSync(root), true);

  fs.mkdirSync(path.join(root, "todo-app"));
  const again = await run("local_build_workspace", {});
  assert.equal(again.projects[0].name, "todo-app");
});

test("full file lifecycle inside the workspace needs no config and no approval", async () => {
  const file = path.join(root, "site", "index.html");
  const wrote = await run("local_write_file", { path: file, content: "<h1>Hello</h1>" });
  assert.equal(wrote.ok, true);

  const read = await run("local_read_file", { path: file });
  assert.equal(read.ok, true);
  assert.match(String(read.content || read.text || ""), /Hello/);

  const edited = await run("local_edit_file", {
    path: file,
    oldText: "Hello",
    newText: "Shipped",
  });
  assert.equal(edited.ok, true);
  assert.match(fs.readFileSync(file, "utf8"), /Shipped/);
});

test("paths outside the workspace are refused with a self-explanatory error", async () => {
  const outside = path.join(os.tmpdir(), "not-workspace.txt");
  const res = await run("local_read_file", { path: outside });
  assert.equal(res.ok, false);
  assert.equal(res.code, "workspace_path_denied");
  assert.match(res.error, /Build workspace/);
});

test("Mac-wide tools are refused in workspace-only sessions", async () => {
  for (const tool of ["local_running_apps", "local_open_app", "local_organize_desktop"]) {
    const res = await run(tool, {});
    assert.equal(res.ok, false, tool);
    assert.match(res.error, /not available/, tool);
  }
});

test("deletes and downloads inside the workspace run without approval", async () => {
  const project = path.join(root, "app");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "junk.txt"), "x");

  const res = await run("local_run_command", {
    command: "rm junk.txt && echo removed",
    cwd: project,
  });
  assert.equal(res.needsApproval, undefined);
  assert.equal(res.ok, true);
  assert.match(res.output, /removed/);
  assert.equal(fs.existsSync(path.join(project, "junk.txt")), false);
});

test("the same delete OUTSIDE the workspace is still consequential", () => {
  const verdict = localSystem.classifyCommandConsequence("rm -rf ./stuff", os.tmpdir());
  assert.equal(verdict.tier, "consequential");
  const inWorkspace = localSystem.classifyCommandConsequence("rm -rf ./stuff", root);
  assert.equal(inWorkspace.tier, "routine");
});

test("workspace paths are allowed even under a restrictive Local Mode config", () => {
  const config = { syncAll: false, syncedFolders: ["/nowhere"], excludedFolders: [] };
  assert.equal(localSystem.isAllowedPath(path.join(root, "x.txt"), config), true);
  assert.equal(localSystem.isAllowedPath(path.join(os.homedir(), "x.txt"), config), false);
});

test("timeoutSec kills slow commands with a pointer to local_start_process", async () => {
  const res = await run("local_run_command", {
    command: "sleep 5",
    cwd: root,
    timeoutSec: 1,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /timed out after 1s/);
  assert.match(res.error, /local_start_process/);
});

test("exit codes and command context come back on failures", async () => {
  const res = await run("local_run_command", {
    command: "node -e 'process.exit(7)'",
    cwd: root,
  });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 7);
});

test("truncated output is recoverable from a full log file", async () => {
  const res = await run("local_run_command", {
    // ~120KB of output vs the 50KB in-context cap.
    command: `node -e "process.stdout.write('x'.repeat(120000)); console.log('THE_END')"`,
    cwd: root,
  });
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.ok(res.fullOutputPath, "expected a fullOutputPath");
  const full = fs.readFileSync(res.fullOutputPath, "utf8");
  assert.match(full, /THE_END/);
});

test("relative paths resolve into the workspace, not the home folder", async () => {
  const wrote = await run("local_write_file", {
    path: "my-app/index.html",
    content: "<h1>relative</h1>",
  });
  assert.equal(wrote.ok, true);
  assert.equal(fs.existsSync(path.join(root, "my-app", "index.html")), true);
});

test("URLs in commands are network targets, never filesystem paths", () => {
  // The E2E run exposed this: curl against a local dev server was denied
  // because /localhost:8000/index.html "looked like" an absolute path.
  const targets = localSystem.commandPathTargets(
    'curl -s -o out.html -w "STATUS %{http_code}" http://localhost:8000/index.html',
    root,
  );
  for (const t of targets) {
    assert.ok(!t.includes("localhost"), `URL leaked into path targets: ${t}`);
  }
  // And the shell's virtual TCP files are sockets, not paths.
  const tcp = localSystem.commandPathTargets("exec 3<>/dev/tcp/127.0.0.1/8000", root);
  assert.equal(tcp.some((t) => t.startsWith("/dev/tcp/")), false);
});

test("commands default to the workspace root as cwd", async () => {
  const res = await run("local_run_command", { command: "pwd" });
  assert.equal(res.ok, true);
  assert.equal(fs.realpathSync(res.output.trim()), fs.realpathSync(root));
});

// ---------------------------------------------------------------------------
// local_install_app — dock installs
// ---------------------------------------------------------------------------

test("local_install_app refuses projects outside the workspace", async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "not-builds-"));
  fs.writeFileSync(path.join(outside, "index.html"), "<html></html>");
  const res = await run("local_install_app", { path: outside });
  assert.equal(res.ok, false);
  assert.match(res.error, /Build workspace/);
  fs.rmSync(outside, { recursive: true, force: true });
});

test("local_install_app demands a production build before installing", async () => {
  const project = path.join(root, "unbuilt-app");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.writeFileSync(path.join(project, "src", "main.tsx"), "console.log('dev only')");

  const res = await run("local_install_app", { path: project });
  assert.equal(res.ok, false);
  assert.equal(res.error, "no_build_output");
  assert.match(res.hint, /npm run build/);
});

test("local_install_app reaches the app host only in the desktop app", async () => {
  // In plain Node the collector succeeds but the Electron-backed host is
  // unavailable; the failure must say so instead of pretending to install.
  const project = path.join(root, "built-app");
  fs.mkdirSync(path.join(project, "dist"), { recursive: true });
  fs.writeFileSync(path.join(project, "dist", "index.html"), "<html>built</html>");

  const res = await run("local_install_app", { path: project });
  assert.equal(res.ok, false);
  assert.match(res.error, /desktop app/);
});
