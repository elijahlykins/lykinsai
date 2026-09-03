/**
 * Consequence-based shell approval + standing authorization.
 *
 * The contract under test: approval is about consequence — commitment,
 * irreversibility, credentials, external impact — not about "the terminal
 * ran". Routine development work (tests, builds, installs, git commits,
 * writing working files) runs without a human pause when the task's
 * capabilities license it; destructive/external commands always pause, and
 * a Routine's standing authorization must NOT change that.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const localSystem = require("./localSystem.cjs");
const { commandPermitted, allowedToolNames } = require("./task-runtime/executors/localCapabilities.cjs");
const { runLocalAgentTask, looksLikeDeleteCommand } = require("./localAgentTask.cjs");

const home = os.homedir();

// ── Tiers ────────────────────────────────────────────────────────────────────

test("ordinary development commands are routine — no approval tier", () => {
  const routine = [
    "npm test",
    "npm install",
    "npm run build",
    "yarn add lodash",
    "pip3 install requests",
    "brew install jq",
    "git status",
    "git add -A",
    "git commit -m 'fix'",
    "mkdir -p src/components",
    "mv notes.txt notes-old.txt",
    "cp a.txt b.txt",
    "echo hello > out.txt",
    "node scripts/build.mjs",
    "npx vitest run",
  ];
  for (const command of routine) {
    const verdict = localSystem.classifyCommandConsequence(command, home);
    assert.equal(verdict.tier, "routine", `${command} should be routine`);
    assert.equal(localSystem.classifyRisk("local_run_command", { command, cwd: home }).risky, false, command);
  }
});

test("delete and download commands stay consequential", () => {
  const consequential = [
    "rm -rf node_modules",
    "rmdir empty-folder",
    "unlink notes.txt",
    "git reset --hard HEAD~3",
    "git clean -fd",
    "curl https://example.test/file.zip -o file.zip",
    "wget https://example.test/file.zip",
    "git clone https://github.com/x/y",
    "scp host:file.txt .",
    "npm test && rm -rf dist",
  ];
  for (const command of consequential) {
    const verdict = localSystem.classifyCommandConsequence(command, home);
    assert.equal(verdict.tier, "consequential", `${command} should be consequential`);
    assert.equal(localSystem.classifyRisk("local_run_command", { command, cwd: home }).risky, true, command);
  }
});

test("privileged, credential, and other mutating commands do not ask", () => {
  const routine = [
    "sudo npm install -g something",
    "chmod 777 secrets",
    "git push origin main",
    "npm publish",
    "killall node",
    "launchctl unload com.apple.something",
    "security find-generic-password -s github",
    "diskutil list",
    "crontab -e",
    "npm test",
  ];
  for (const command of routine) {
    assert.equal(
      localSystem.classifyCommandConsequence(command, home).tier,
      "routine",
      `${command} should be routine`,
    );
  }
});

test("working outside the home directory does not by itself require approval", () => {
  assert.equal(localSystem.classifyCommandConsequence("npm test", "/etc").tier, "routine");
});

// ── Capability boundaries under the new tiers ────────────────────────────────

test("read-only shell capability does NOT widen to routine-but-mutating commands", () => {
  const caps = ["files.read", "local.shell.read"];
  const readRisk = localSystem.classifyRisk("local_run_command", { command: "git status", cwd: home });
  assert.equal(commandPermitted("git status", caps, readRisk), true);

  // npm install is routine-tier (no approval) but it MUTATES — shell.read
  // must not license it just because it isn't "risky" anymore.
  const installRisk = localSystem.classifyRisk("local_run_command", { command: "npm install", cwd: home });
  assert.equal(installRisk.risky, false);
  assert.equal(commandPermitted("npm install", caps, installRisk), false);

  assert.equal(commandPermitted("npm install", ["local.shell.execute"], installRisk), true);
});

// ── The loop: standing authorization vs interactive gates ────────────────────

function fakeModelActing(decisions) {
  let round = 0;
  return async () => ({
    ok: true,
    json: async () => ({
      ok: true,
      json: decisions[Math.min(round++, decisions.length - 1)],
    }),
  });
}

const LOOP_DEFAULTS = {
  apiBase: "https://example.test",
  getAuthToken: async () => "token",
  maxRounds: 2,
};

test("a routine shell command inside the envelope runs with NO approval pause", async () => {
  const calls = [];
  let approvalAsked = 0;
  await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "run the tests",
    capabilities: ["files.read", "local.shell.execute"],
    allowedTools: allowedToolNames(["files.read", "local.shell.execute"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_run_command", args: { command: "npm test", cwd: home } },
      { kind: "finish", status: "completed", answer: "tests ran" },
    ]),
    onApprovalNeeded: async () => {
      approvalAsked += 1;
      return true;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, output: "42 passing" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.command, "npm test");
  assert.equal(approvalAsked, 0, "routine-tier commands never pause for approval");
});

test("a consequential command pauses even under standing authorization", async () => {
  const calls = [];
  const questions = [];
  const out = await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "clean up the repo",
    standingAuthorization: true,
    capabilities: ["files.read", "files.write", "files.delete", "local.shell.execute"],
    allowedTools: allowedToolNames(["files.read", "files.write", "files.delete", "local.shell.execute"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_run_command", args: { command: "rm -rf dist", cwd: home } },
    ]),
    onApprovalNeeded: async ({ question }) => {
      questions.push(question);
      return false; // nobody clicked approve
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
  });
  assert.equal(calls.length, 0, "declined consequential action never executed");
  assert.equal(questions.length, 1);
  assert.equal(out.status, "waiting_for_user");
});

test("standing authorization writes working files without a per-action pause", async () => {
  const calls = [];
  let approvalAsked = 0;
  await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "update the summary file",
    standingAuthorization: true,
    capabilities: ["files.read", "files.write"],
    allowedTools: allowedToolNames(["files.read", "files.write"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_write_file", args: { path: "summary.md", content: "# Summary" } },
      { kind: "finish", status: "completed", answer: "written" },
    ]),
    onApprovalNeeded: async () => {
      approvalAsked += 1;
      return true;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "local_write_file");
  assert.equal(approvalAsked, 0);
});

test("writes run without a per-action pause even without standing authorization", async () => {
  const calls = [];
  let approvalAsked = 0;
  await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "update the summary file",
    capabilities: ["files.read", "files.write"],
    allowedTools: allowedToolNames(["files.read", "files.write"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_write_file", args: { path: "summary.md", content: "# Summary" } },
      { kind: "finish", status: "completed", answer: "written" },
    ]),
    onApprovalNeeded: async () => {
      approvalAsked += 1;
      return true;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "local_write_file");
  assert.equal(approvalAsked, 0);
});

test("listing and reading files does not pause for approval", async () => {
  const calls = [];
  let approvalAsked = 0;
  await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "list the folder then read notes.txt",
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_list_dir", args: { path: "~/Documents" } },
      { kind: "act", tool: "local_read_file", args: { path: "notes.txt" } },
      { kind: "finish", status: "completed", answer: "listed" },
    ]),
    onApprovalNeeded: async () => {
      approvalAsked += 1;
      return true;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, entries: [], content: "hello" };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(approvalAsked, 0, "reads and listings never pause for approval");
});

test("pulling a file into chat still pauses for approval", async () => {
  const calls = [];
  const questions = [];
  const out = await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "pull the photo into the chat",
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_pull_file", args: { path: "~/Pictures/photo.png" } },
    ]),
    onApprovalNeeded: async ({ question }) => {
      questions.push(question);
      return false;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
  });
  assert.equal(calls.length, 0, "declined download never executed");
  assert.equal(questions.length, 1);
  assert.match(questions[0], /Download|photo/i);
  assert.equal(out.status, "waiting_for_user");
});

test("standing authorization covers reads — an unattended run cannot wait for a grant", async () => {
  const calls = [];
  let approvalAsked = 0;
  await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "read the notes",
    standingAuthorization: true,
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_read_file", args: { path: "notes.txt" } },
      { kind: "finish", status: "completed", answer: "read" },
    ]),
    onApprovalNeeded: async () => {
      approvalAsked += 1;
      return true;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true, content: "hello" };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(approvalAsked, 0);
});

test("standing authorization cannot exceed the capability envelope", async () => {
  const calls = [];
  await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "read the notes",
    standingAuthorization: true,
    capabilities: ["files.read"],
    allowedTools: allowedToolNames(["files.read"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_run_command", args: { command: "npm test", cwd: home } },
    ]),
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
  });
  assert.equal(calls.length, 0, "no shell capability means no shell, standing auth or not");
});

test("delete-shaped commands are recognized", () => {
  assert.equal(looksLikeDeleteCommand("rm -rf dist"), true);
  assert.equal(looksLikeDeleteCommand("git clean -fd"), true);
  assert.equal(looksLikeDeleteCommand("npm test"), false);
});

test("bot tasks refuse delete commands without asking", async () => {
  const calls = [];
  let approvalAsked = 0;
  const out = await runLocalAgentTask({
    ...LOOP_DEFAULTS,
    goal: "delete the dist folder",
    forbidDeletes: true,
    capabilities: ["files.read", "files.write", "files.delete", "local.shell.execute"],
    allowedTools: allowedToolNames(["files.read", "files.write", "files.delete", "local.shell.execute"]),
    fetchImpl: fakeModelActing([
      { kind: "act", tool: "local_run_command", args: { command: "rm -rf dist", cwd: home } },
      { kind: "finish", answer: "I cannot delete files." },
    ]),
    onApprovalNeeded: async () => {
      approvalAsked += 1;
      return true;
    },
    runTool: async (tool, args) => {
      calls.push({ tool, args });
      return { ok: true };
    },
  });
  assert.equal(calls.length, 0, "delete never executed");
  assert.equal(approvalAsked, 0, "delete is refused, not approved");
  assert.equal(out.status, "completed");
  assert.match(out.answer, /cannot delete/i);
});
