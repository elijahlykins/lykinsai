/**
 * Managed processes are what make dev servers possible, so the contract that
 * matters is lifecycle truth: a started server reports running with its port,
 * an immediate crash reports the exit code and its own words, and stop
 * actually terminates the process group.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const pm = require("./processManager.cjs");

test.afterEach(() => {
  pm.resetForTests();
});

test("a server-style process reports running, detects its port, and stops", async () => {
  const started = await pm.startProcess({
    command:
      `node -e "console.log('dev server on http://localhost:43219'); setInterval(() => {}, 1000)"`,
    cwd: process.cwd(),
    name: "fake dev server",
    waitMs: 1200,
  });

  assert.equal(started.ok, true);
  assert.equal(started.running, true);
  assert.equal(started.port, 43219);
  assert.equal(started.url, "http://localhost:43219");
  assert.match(started.logTail, /dev server on/);

  const status = pm.processStatus({ processId: started.processId });
  assert.equal(status.ok, true);
  assert.equal(status.running, true);

  const stopped = await pm.stopProcess({ processId: started.processId });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.running, false);
});

test("starting the same command in the same cwd replaces the running instance", async () => {
  const command = `node -e "console.log('serving'); setInterval(() => {}, 1000)"`;
  const first = await pm.startProcess({ command, cwd: process.cwd(), waitMs: 600 });
  assert.equal(first.running, true);

  // The live failure: "run the dev server" on a project whose server was
  // already up piled a second instance onto the port, and the stale one had
  // no off switch. Same (cwd, command) is a restart, not a second server.
  const second = await pm.startProcess({ command, cwd: process.cwd(), waitMs: 600 });
  assert.equal(second.ok, true);
  assert.equal(second.running, true);
  assert.equal(second.replacedProcessId, first.processId);
  assert.notEqual(second.processId, first.processId);

  const old = pm.processStatus({ processId: first.processId });
  assert.equal(old.running, false);

  // A DIFFERENT command in the same cwd (e.g. a test watcher next to the dev
  // server) is not a restart and must coexist.
  const watcher = await pm.startProcess({
    command: `node -e "console.log('watching'); setInterval(() => {}, 1000)"`,
    cwd: process.cwd(),
    waitMs: 600,
  });
  assert.equal(watcher.running, true);
  assert.equal(watcher.replacedProcessId, undefined);
  assert.equal(pm.processStatus({ processId: second.processId }).running, true);
});

test("an immediate crash reports the exit code and the process's own words", async () => {
  const started = await pm.startProcess({
    command: `node -e "console.error('missing module: express'); process.exit(3)"`,
    cwd: process.cwd(),
    waitMs: 5000,
  });

  assert.equal(started.ok, false);
  assert.equal(started.running, false);
  assert.equal(started.exitCode, 3);
  assert.match(started.logTail, /missing module: express/);
  assert.match(String(started.error || ""), /exited almost immediately/);
});

test("status without an id lists every tracked process", async () => {
  await pm.startProcess({
    command: `node -e "process.exit(0)"`,
    cwd: process.cwd(),
    waitMs: 3000,
  });
  const all = pm.processStatus({});
  assert.equal(all.ok, true);
  assert.equal(Array.isArray(all.processes), true);
  assert.equal(all.processes.length, 1);
});

test("unknown ids get a self-explanatory error, not a crash", async () => {
  const status = pm.processStatus({ processId: "proc_999" });
  assert.equal(status.ok, false);
  assert.match(status.error, /No managed process/);

  const stopped = await pm.stopProcess({ processId: "proc_999" });
  assert.equal(stopped.ok, false);
});

test("port detection understands common dev-server log lines", () => {
  assert.equal(pm.detectPort("Local:   http://localhost:5173/"), 5173);
  assert.equal(pm.detectPort("listening on 127.0.0.1:8000"), 8000);
  assert.equal(pm.detectPort("Server started on port 3000"), 3000);
  assert.equal(pm.detectPort("no address here"), null);
});
