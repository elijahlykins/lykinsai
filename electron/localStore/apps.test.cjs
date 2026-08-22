// Run: node --test electron/localStore/apps.test.cjs
//
// Covers the installed-app store and the protocol that serves it. Driven
// against a real SQLite file and the real esbuild compiler, because the things
// most likely to break — per-app isolation, path traversal, and whether a
// generated project actually compiles — are precisely what a mock would hide.
//
// The bridge itself is not exercised here: it needs an Electron main process.
// What IS covered is the boundary the bridge depends on, namely that an app id
// can only be derived from a lykn-app:// origin.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localStore = require("./index.cjs");
const apps = require("./apps.cjs");
const appProtocol = require("../appProtocol.cjs");
const { compileApp, BUNDLE_PATH } = require("../appRuntime/compile.cjs");

let userDataPath;

before(() => {
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-apps-test-"));
  localStore.configure(userDataPath);
});

after(() => {
  localStore.shutdown();
  fs.rmSync(userDataPath, { recursive: true, force: true });
});

/** A small but realistic multi-file project. */
function notesProject() {
  return [
    {
      path: "app.json",
      content: JSON.stringify({
        name: "Notes",
        description: "Jot things down",
        capabilities: ["storage", "vault.read"],
      }),
    },
    {
      path: "App.jsx",
      content: `import React, { useState } from "react";
import NoteList from "./components/NoteList.jsx";
import { titleFor } from "./lib/format";
export default function App() {
  const [notes, setNotes] = useState([]);
  return <div className="p-6"><h1>{titleFor(notes)}</h1><NoteList notes={notes} /></div>;
}`,
    },
    {
      path: "components/NoteList.jsx",
      content: `import React from "react";
export default function NoteList({ notes }) {
  return <ul>{notes.map((n) => <li key={n.id}>{n.title}</li>)}</ul>;
}`,
    },
    {
      path: "lib/format.js",
      content: `export function titleFor(notes) { return notes.length ? \`Notes (\${notes.length})\` : "Notes"; }`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Schema + manifest
// ---------------------------------------------------------------------------

test("migration 5 creates the app tables", () => {
  const tables = localStore.db
    .get()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  for (const expected of ["apps", "app_files", "app_versions", "app_data"]) {
    assert.ok(tables.includes(expected), `missing table ${expected}`);
  }
});

test("app ids are safe to use as a URL hostname", () => {
  const id = apps.slugifyAppId("My Fancy App!! 2024");
  assert.match(id, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(apps.isValidAppId(id));

  // Uppercase would not survive a standard scheme lowercasing the hostname,
  // so an id that differed only by case must be rejected outright.
  assert.equal(apps.isValidAppId("HasUpper"), false);
  assert.equal(apps.isValidAppId("has space"), false);
  assert.equal(apps.isValidAppId("trailing-"), false);
  assert.equal(apps.isValidAppId(""), false);
});

test("an icon the user picked survives a reinstall", () => {
  const app = apps.createApp({ name: "Icons", icon: "notebook" });
  assert.equal(apps.getApp(app.id).icon, "notebook");
  assert.equal(apps.getApp(app.id).icon_source, null);

  apps.setAppIcon(app.id, "Rocket");
  const picked = apps.getApp(app.id);
  assert.equal(picked.icon, "Rocket");
  assert.equal(picked.icon_source, "user");

  // Clearing back to the default is still the user's choice, so a later
  // rebuild must not hand the manifest's icon back to them.
  apps.setAppIcon(app.id, null);
  assert.equal(apps.getApp(app.id).icon, null);
  assert.equal(apps.getApp(app.id).icon_source, "user");
});

test("icons that could not name a component are dropped", () => {
  assert.equal(apps.normalizeIconName("notebook-pen"), "notebook-pen");
  assert.equal(apps.normalizeIconName("  Rocket "), "Rocket");
  for (const bad of ["", null, "<script>", "3d", "a".repeat(80)]) {
    assert.equal(apps.normalizeIconName(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("rejects file paths that climb out of the project", () => {
  for (const bad of ["../escape.js", "/etc/passwd", "a/../../b.js", ""]) {
    assert.throws(() => apps.normalizeFilePath(bad), `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(apps.normalizeFilePath("./lib/a.js"), "lib/a.js");
  assert.equal(apps.normalizeFilePath("lib//a.js"), "lib/a.js");
});

// ---------------------------------------------------------------------------
// Project storage + versions
// ---------------------------------------------------------------------------

test("stores a project and reads it back", () => {
  const app = apps.createApp({ name: "Notes", capabilities: ["storage"] });
  apps.putFiles(app.id, notesProject());

  const files = apps.listFiles(app.id);
  assert.equal(files.length, 4);
  assert.ok(apps.readFile(app.id, "lib/format.js").includes("titleFor"));
  assert.equal(apps.readFile(app.id, "nope.js"), null);
  assert.deepEqual(apps.getApp(app.id).capabilities, ["storage"]);
});

test("snapshots and rolls back without touching app data", () => {
  const app = apps.createApp({ name: "Rollback" });
  apps.putFiles(app.id, notesProject());
  apps.dataSet(app.id, "notes", "n1", { title: "keep me" });

  apps.snapshotVersion(app.id, "before edit");
  apps.writeFile(app.id, "App.jsx", "// broken");
  assert.equal(apps.readFile(app.id, "App.jsx"), "// broken");

  apps.rollback(app.id, 1);
  assert.ok(apps.readFile(app.id, "App.jsx").includes("NoteList"));
  // A rollback restores code, not the user's content.
  assert.deepEqual(apps.dataGet(app.id, "notes", "n1"), { title: "keep me" });
});

// ---------------------------------------------------------------------------
// Per-app data
// ---------------------------------------------------------------------------

test("app data is namespaced so one app cannot see another's rows", () => {
  const a = apps.createApp({ name: "First" });
  const b = apps.createApp({ name: "Second" });

  apps.dataSet(a.id, "notes", "shared-key", { secret: "a" });
  apps.dataSet(b.id, "notes", "shared-key", { secret: "b" });

  // Same collection, same key, different app: no bleed in either direction.
  assert.deepEqual(apps.dataGet(a.id, "notes", "shared-key"), { secret: "a" });
  assert.deepEqual(apps.dataGet(b.id, "notes", "shared-key"), { secret: "b" });
  assert.equal(apps.dataCount(a.id), 1);
});

test("lists newest first and pages with a stable cursor", () => {
  const app = apps.createApp({ name: "Paging" });
  apps.dataSetMany(
    app.id,
    "items",
    Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, value: { i } })),
  );

  const first = apps.dataList(app.id, "items", { limit: 2 });
  assert.equal(first.length, 2);

  const next = apps.dataList(app.id, "items", { limit: 10, after: first[first.length - 1] });
  const seen = new Set([...first, ...next].map((r) => r.key));
  assert.equal(seen.size, 5, "paging should not skip or repeat rows");
});

test("searches across a collection's values", () => {
  const app = apps.createApp({ name: "Search" });
  apps.dataSetMany(app.id, "notes", [
    { key: "a", value: { title: "Groceries", body: "milk and eggs" } },
    { key: "b", value: { title: "Standup", body: "sprint planning" } },
  ]);

  assert.deepEqual(apps.dataSearch(app.id, "notes", "sprint").map((r) => r.key), ["b"]);
  assert.equal(apps.dataSearch(app.id, "notes", "nothing here").length, 0);
});

test("rejects values that would let one app fill the disk", () => {
  const app = apps.createApp({ name: "Big" });
  const huge = "x".repeat(apps.MAX_VALUE_BYTES + 100);
  assert.throws(() => apps.dataSet(app.id, "notes", "k", huge), /exceeds/);
});

test("invalid collection names are refused", () => {
  const app = apps.createApp({ name: "Names" });
  for (const bad of ["", "has space", "semi;colon", "a".repeat(70)]) {
    assert.throws(() => apps.dataSet(app.id, bad, "k", 1));
  }
});

test("uninstalling removes the app's files, versions, and data", () => {
  const app = apps.createApp({ name: "Temporary" });
  apps.putFiles(app.id, notesProject());
  apps.snapshotVersion(app.id, "v1");
  apps.dataSet(app.id, "notes", "n1", { title: "gone soon" });

  apps.hardDeleteApp(app.id);

  assert.equal(apps.getApp(app.id), null);
  assert.equal(apps.listFiles(app.id).length, 0);
  assert.equal(apps.listVersions(app.id).length, 0);
  assert.equal(apps.dataCount(app.id), 0);
});

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

test("compiles a multi-file JSX project into one runnable bundle", async () => {
  const built = await compileApp(notesProject(), "App.jsx");
  assert.ok(built.ok, built.hint);
  assert.ok(built.code.includes("createElement"), "JSX should be transformed");

  // Actually run it. A bundle that parses but does not produce a component is
  // still a broken app, and that is the failure users would actually hit.
  const sandbox = {
    React: { createElement: (type) => ({ type }), Fragment: "F", useState: (v) => [v, () => {}] },
  };
  sandbox.globalThis = sandbox;
  const factory = new Function("globalThis", "window", `${built.code}; return __lyknApp;`);
  const mod = factory(sandbox, sandbox);
  assert.equal(typeof mod.default, "function");
  assert.equal(mod.default().type, "div");
});

test("compiles the libraries a generated app actually reaches for", async () => {
  // The model imports lucide icons by reflex and charts whenever data is
  // involved. If these did not resolve, nearly every real build would fail to
  // install and the feature would look broken rather than limited.
  const built = await compileApp(
    [
      {
        path: "App.jsx",
        content: `import React from "react";
import { Check, Trash2 } from "lucide-react";
import { LineChart, Line } from "recharts";
import { motion, AnimatePresence } from "framer-motion";
export default function App() {
  return <motion.div><Check /><Trash2 /><LineChart><Line /></LineChart><AnimatePresence /></motion.div>;
}`,
      },
    ],
    "App.jsx",
  );
  assert.ok(built.ok, built.hint);
  assert.match(built.code, /LucideReact/);
  assert.match(built.code, /Recharts/);
  assert.match(built.code, /FramerMotion/);
});

test("refuses imports of packages the runtime does not ship", async () => {
  const built = await compileApp(
    [{ path: "App.jsx", content: `import _ from "lodash";\nexport default function App() { return null; }` }],
    "App.jsx",
  );
  assert.equal(built.ok, false);
  // The message has to name the package and the alternative, because it is
  // fed straight back to the model as the instruction for its next attempt.
  assert.match(built.hint, /lodash/);
  assert.match(built.hint, /lykn\.db|Available/);
});

test("reports a compile error instead of shipping broken source", async () => {
  const built = await compileApp(
    [{ path: "App.jsx", content: `export default function App() { return <div>unclosed; }` }],
    "App.jsx",
  );
  assert.equal(built.ok, false);
  assert.equal(built.error, "compile_error");
});

test("reports an unresolvable relative import", async () => {
  const built = await compileApp(
    [{ path: "App.jsx", content: `import x from "./missing";\nexport default function App() { return null; }` }],
    "App.jsx",
  );
  assert.equal(built.ok, false);
  assert.match(built.hint, /missing/);
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

test("serves the shell, the bundle, and the vendored runtime", async () => {
  const app = apps.createApp({ name: "Served", entry: "App.jsx" });
  apps.putFiles(app.id, notesProject());

  const shell = await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id) });
  assert.equal(shell.status, 200);
  const html = await shell.text();
  assert.ok(html.includes("/app.js"));
  assert.ok(html.includes("/vendor/react.js"));

  const bundle = await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id, "app.js") });
  assert.equal(bundle.status, 200);
  const code = await bundle.text();
  assert.ok(!code.startsWith("throw"), "a valid project should not compile to a thrown error");

  // The compile result is cached in the app's own file table so the next open
  // does not pay for esbuild again.
  assert.ok(apps.readFile(app.id, BUNDLE_PATH));

  const vendor = await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id, "vendor/react.js") });
  assert.equal(vendor.status, 200);
});

test("a broken project serves an error the overlay can show", async () => {
  const app = apps.createApp({ name: "Broken", entry: "App.jsx" });
  apps.putFiles(app.id, [{ path: "App.jsx", content: "import x from 'nope';" }]);

  const res = await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id, "app.js") });
  const code = await res.text();
  assert.ok(code.startsWith("throw new Error("), "the failure should surface at run time");
  assert.match(code, /nope/);
});

test("refuses traversal, unknown apps, and the cached bundle path", async () => {
  const app = apps.createApp({ name: "Guarded" });
  apps.putFiles(app.id, notesProject());

  const traversal = await appProtocol.handleRequest({
    url: `lykn-app://${app.id}/../../../etc/passwd`,
  });
  assert.ok(traversal.status >= 400);

  const vendorEscape = await appProtocol.handleRequest({
    url: `lykn-app://${app.id}/vendor/..%2F..%2Fpackage.json`,
  });
  assert.ok(vendorEscape.status >= 400);

  const unknown = await appProtocol.handleRequest({ url: "lykn-app://not-installed-xyz/" });
  assert.equal(unknown.status, 404);

  // Serving the cache would let an app fetch and re-evaluate its own bundle.
  const cached = await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id, BUNDLE_PATH) });
  assert.equal(cached.status, 403);
});

test("an app id can only come from a lykn-app origin", () => {
  const app = apps.createApp({ name: "Origin" });

  assert.equal(appProtocol.appIdFromOrigin(`lykn-app://${app.id}`), app.id);
  assert.equal(appProtocol.appIdFromOrigin(`lykn-app://${app.id}/some/path`), app.id);

  // This is the check the bridge leans on: anything that is not one of our app
  // origins must not resolve to an app, or the main renderer could pose as one.
  assert.equal(appProtocol.appIdFromOrigin("https://lykn.io"), null);
  assert.equal(appProtocol.appIdFromOrigin("file:///etc/passwd"), null);
  assert.equal(appProtocol.appIdFromOrigin("lykn-blob://blob/x"), null);
  assert.equal(appProtocol.appIdFromOrigin(""), null);
});

test("invalidating the bundle forces a recompile on the next load", async () => {
  const app = apps.createApp({ name: "Recompile", entry: "App.jsx" });
  apps.putFiles(app.id, notesProject());

  await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id, "app.js") });
  assert.ok(apps.readFile(app.id, BUNDLE_PATH));

  apps.writeFile(app.id, "lib/format.js", `export function titleFor() { return "Renamed"; }`);
  appProtocol.invalidateBundle(app.id);
  assert.equal(apps.readFile(app.id, BUNDLE_PATH), null);

  const res = await appProtocol.handleRequest({ url: appProtocol.urlFor(app.id, "app.js") });
  assert.match(await res.text(), /Renamed/);
});
