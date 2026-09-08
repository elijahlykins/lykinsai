"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CATALOG,
  resolveCatalogEntry,
  searchCatalog,
  detectInstalled,
  clearDetectCache,
  catalogForClient,
  searchRegistry,
  commandForRegistryPackage,
  envKeysForRegistryPackage,
} = require("./desktopMcpCatalog.cjs");
const { parseLocalCommand, assertLocalCommandSafe } = require("./localCommandPolicy.cjs");

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

test("every catalog entry launches through the command policy unchanged", () => {
  for (const entry of CATALOG) {
    const parsed = parseLocalCommand(entry.commandLine);
    assert.equal(parsed.ok, true, `${entry.id}: ${entry.commandLine}`);
    const safe = assertLocalCommandSafe({
      command: parsed.command,
      args: parsed.args,
      confirmInstall: true,
    });
    assert.equal(safe.ok, true, `${entry.id}: ${safe.error || ""}`);
  }
});

test("catalog entries are well-formed (ids unique, env names spawnable)", () => {
  const ids = new Set();
  for (const entry of CATALOG) {
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(entry.name && entry.description && entry.homepage, entry.id);
    for (const key of entry.envKeys) {
      // desktopChildEnv silently drops invalid names — a typo here would ship
      // a key the server never receives.
      assert.match(key.name, ENV_NAME_RE, `${entry.id}: ${key.name}`);
      assert.ok(key.label && key.hint, `${entry.id}: ${key.name} needs label+hint`);
    }
  }
  assert.ok(CATALOG.length >= 20, "catalog should cover the common apps");
});

test("resolveCatalogEntry: id, name, alias, and fuzzy forms all land", () => {
  assert.equal(resolveCatalogEntry("blender").id, "blender");
  assert.equal(resolveCatalogEntry("Blender").id, "blender");
  assert.equal(resolveCatalogEntry("b3d").id, "blender");
  assert.equal(resolveCatalogEntry("Ableton Live").id, "ableton");
  assert.equal(resolveCatalogEntry("ableton").id, "ableton");
  assert.equal(resolveCatalogEntry("gh").id, "github");
  assert.equal(resolveCatalogEntry("davinci").id, "davinci-resolve");
  assert.equal(resolveCatalogEntry("definitely-not-a-thing"), null);
  assert.equal(resolveCatalogEntry(""), null);
});

test("CAD, Adobe, and DAW entries resolve from user vocabulary", () => {
  // An engineer says "cad", a designer says "photoshop", a producer says
  // "daw" — the catalog is what makes LYKN open to all three without
  // tool-specific plumbing anywhere else.
  assert.equal(resolveCatalogEntry("FreeCAD").id, "freecad");
  assert.equal(resolveCatalogEntry("cad").id, "freecad");
  assert.equal(resolveCatalogEntry("kicad").id, "kicad");
  assert.equal(resolveCatalogEntry("pcb design").id, "kicad");
  assert.equal(resolveCatalogEntry("photoshop").id, "adobe");
  assert.equal(resolveCatalogEntry("after effects").id, "after-effects");
  assert.equal(resolveCatalogEntry("ae").id, "after-effects");
  assert.equal(resolveCatalogEntry("premiere").id, "adobe");
  assert.equal(resolveCatalogEntry("reaper").id, "reaper");
  assert.equal(resolveCatalogEntry("daw").id, "reaper");
  assert.equal(resolveCatalogEntry("sketchup").id, "sketchup");
  // Zero-config launches: connecting must not demand API keys for local apps.
  for (const id of ["freecad", "kicad", "sketchup", "adobe", "after-effects", "reaper"]) {
    const entry = CATALOG.find((e) => e.id === id);
    assert.equal(entry.envKeys.length, 0, `${id} should be zero-key`);
  }
});

test("macOS-hostile packages are banned from the catalog", () => {
  // Learned the hard way (a user's live session hit both dead ends):
  //  • "adobe-mcp" (npm + PyPI) runs every tool through powershell.exe —
  //    Windows-only, though it handshakes fine on a Mac and looks connected.
  //  • "applescript-mcp" (npm) refuses to start unless Xcode is installed.
  // Adobe/AppleScript lanes go through macos-automator-mcp (plain osascript,
  // zero prerequisites) and the dedicated after-effects-mcp server instead.
  for (const entry of CATALOG) {
    assert.ok(!/(^|\s)adobe-mcp\b/.test(entry.commandLine), `${entry.id} uses adobe-mcp`);
    assert.ok(!/(^|\s)applescript-mcp\b/.test(entry.commandLine), `${entry.id} uses applescript-mcp`);
  }
  assert.equal(
    CATALOG.find((e) => e.id === "adobe").commandLine,
    "npx -y --package @steipete/macos-automator-mcp macos-automator-mcp",
  );
  assert.equal(
    CATALOG.find((e) => e.id === "applescript").commandLine,
    "npx -y --package @steipete/macos-automator-mcp macos-automator-mcp",
  );
  assert.equal(
    CATALOG.find((e) => e.id === "after-effects").commandLine,
    "npx -y after-effects-mcp",
  );
});

test("searchCatalog ranks capability words, empty query lists all", () => {
  const three_d = searchCatalog("3d modeling");
  assert.equal(three_d[0].id, "blender");
  const browser = searchCatalog("browser automation");
  assert.equal(browser[0].id, "playwright");
  assert.equal(searchCatalog("").length, CATALOG.length);
  assert.equal(searchCatalog("zzzz-nothing").length, 0);
});

test("detectInstalled badges from /Applications and PATH bins", () => {
  clearDetectCache();
  const fakeFs = {
    readdirSync: () => ["Blender.app", "Ableton Live 12 Suite.app", "Safari.app"],
    existsSync: (p) => p.endsWith("/git"),
  };
  const found = detectInstalled({ fsImpl: fakeFs });
  assert.ok(found.has("blender"));
  assert.ok(found.has("ableton"));
  assert.ok(found.has("git"));
  assert.ok(!found.has("obsidian"));
  clearDetectCache();
});

test("catalogForClient merges detection + connections and hides nothing needed", () => {
  clearDetectCache();
  const fakeFs = { readdirSync: () => ["Blender.app"], existsSync: () => false };
  const detected = detectInstalled({ fsImpl: fakeFs });
  const entries = catalogForClient({
    query: "blender",
    connectedNames: ["Blender"],
    detected,
  });
  const blender = entries.find((e) => e.id === "blender");
  assert.equal(blender.detected, true);
  assert.equal(blender.connected, true);
  assert.equal(blender.command, "uvx blender-mcp");
  assert.ok(blender.setup.length > 0);
  assert.equal(blender.verified, true);
  clearDetectCache();
});

test("v1-API Python servers keep their mcp<2 pin", () => {
  // The MCP Python SDK 2.x renamed FastMCP; these servers are written against
  // v1 but don't bound their own dependency, so a fresh install crashes at
  // import ("No module named mcp.server.fastmcp") without this pin.
  const pinned = [
    "davinci-resolve",
    "unity",
    "freecad",
    "kicad",
    "sketchup",
    "youtube-transcript",
  ];
  for (const id of pinned) {
    const entry = CATALOG.find((e) => e.id === id);
    assert.ok(entry, `${id} missing from catalog`);
    assert.match(entry.commandLine, /^uvx --with "mcp<2" /, `${id}: ${entry.commandLine}`);
    const parsed = parseLocalCommand(entry.commandLine);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.args.slice(0, 2), ["--with", "mcp<2"]);
  }
});

test("commandForRegistryPackage: npm→npx, pypi→uvx, junk and remote rejected", () => {
  // Live API shape (camelCase + transport)
  assert.equal(
    commandForRegistryPackage({
      registryType: "npm",
      identifier: "@scope/thing",
      transport: { type: "stdio" },
    }),
    "npx -y @scope/thing",
  );
  // Older snake_case payloads still parse
  assert.equal(
    commandForRegistryPackage({ registry_type: "pypi", identifier: "some-mcp" }),
    "uvx some-mcp",
  );
  assert.equal(
    commandForRegistryPackage({ registry_name: "pypi", name: "some-mcp" }),
    "uvx some-mcp",
  );
  assert.equal(commandForRegistryPackage({ registryType: "docker", identifier: "img" }), null);
  // Remote transports are not ours to launch
  assert.equal(
    commandForRegistryPackage({
      registryType: "npm",
      identifier: "thing",
      transport: { type: "streamable-http" },
    }),
    null,
  );
  assert.equal(
    commandForRegistryPackage({ registryType: "npm", identifier: "evil; rm -rf" }),
    null,
  );
});

test("envKeysForRegistryPackage keeps required keys, drops defaulted ones", () => {
  const keys = envKeysForRegistryPackage({
    environmentVariables: [
      { name: "SOME_API_KEY", description: "Get it from the dashboard" },
      { name: "BRIDGE_PORT", description: "port", default: "9765" },
      { name: "not-valid-name", description: "skipped" },
      { name: "OPTIONAL_ONE", description: "optional", isRequired: false },
    ],
  });
  assert.equal(keys.length, 1);
  assert.equal(keys[0].name, "SOME_API_KEY");
  assert.match(keys[0].hint, /dashboard/);
});

test("searchRegistry folds registry servers and fails soft", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      servers: [
        {
          server: {
            name: "io.github.someone/krita-mcp",
            description: "Control Krita",
            packages: [
              {
                registryType: "pypi",
                identifier: "krita-mcp",
                transport: { type: "stdio" },
                environmentVariables: [{ name: "KRITA_TOKEN", description: "From Krita settings" }],
              },
            ],
            repository: { url: "https://github.com/someone/krita-mcp" },
          },
        },
        { server: { name: "no-packages/skip", description: "skipped", packages: [] } },
      ],
    }),
  });
  const results = await searchRegistry("krita", { fetchImpl: fakeFetch, now: Date.now() });
  assert.equal(results.length, 1);
  assert.equal(results[0].command, "uvx krita-mcp");
  assert.equal(results[0].verified, false);
  assert.equal(results[0].envKeys[0].name, "KRITA_TOKEN");

  const down = await searchRegistry("other-query", {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    now: Date.now(),
  });
  assert.deepEqual(down, []);
});
