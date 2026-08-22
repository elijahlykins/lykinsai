/**
 * Smoke test for installed apps inside a real Electron process.
 *
 * `npm run test:apps` covers the store, the compiler, and the protocol handler
 * as plain functions. What it cannot cover is the part the whole design rests
 * on: whether Chromium actually treats `lykn-app://` as a secure origin, and
 * therefore whether localStorage and IndexedDB work inside a generated app.
 * That is only answerable by loading a real window in a real Electron process,
 * which is what this does.
 *
 * Run: npm run verify:apps
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { app, protocol, session, BrowserWindow } = require("electron");

const appProtocol = require("../electron/appProtocol.cjs");

// Must happen before app-ready, exactly as main.cjs does it.
protocol.registerSchemesAsPrivileged([appProtocol.schemeRegistration()]);

const localStore = require("../electron/localStore/index.cjs");
const appBridge = require("../electron/appBridge.cjs");
const appHost = require("../electron/appHost.cjs");

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A small app that exercises storage the way a real generated app would. */
function storageProbeProject() {
  return [
    {
      path: "app.json",
      content: JSON.stringify({ name: "Probe", description: "storage probe", capabilities: ["storage"] }),
    },
    {
      path: "App.jsx",
      content: `import React, { useEffect, useState } from "react";

export default function App() {
  const [report, setReport] = useState("running");
  useEffect(() => {
    (async () => {
      const out = {};
      try { localStorage.setItem("probe", "yes"); out.localStorage = localStorage.getItem("probe"); }
      catch (e) { out.localStorage = "THREW: " + e.message; }
      try {
        out.indexedDB = await new Promise((resolve) => {
          const req = indexedDB.open("probe-db", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("kv");
          req.onsuccess = () => { req.result.close(); resolve("ok"); };
          req.onerror = () => resolve("THREW: " + (req.error && req.error.message));
        });
      } catch (e) { out.indexedDB = "THREW: " + e.message; }
      out.isSecureContext = String(window.isSecureContext);
      out.origin = String(window.location.origin);
      try {
        await lykn.db.set("notes", "n1", { title: "from inside the app" });
        const back = await lykn.db.get("notes", "n1");
        out.bridge = back && back.title === "from inside the app" ? "ok" : "mismatch";
      } catch (e) { out.bridge = "THREW: " + e.message; }
      try { await lykn.vault.list(); out.ungrantedVault = "ALLOWED"; }
      catch (e) { out.ungrantedVault = "refused"; }
      window.__probe = out;
      setReport("done");
    })();
  }, []);
  return <div>{report}</div>;
}`,
    },
  ];
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-apps-verify-"));
  console.log(`electron ${process.versions.electron} | node ${process.versions.node}`);
  console.log(`userData: ${userDataPath}\n`);

  localStore.configure(userDataPath);
  appProtocol.bind(session.defaultSession);
  appBridge.bind();

  // --- install ------------------------------------------------------------
  const installed = await appHost.installApp({ title: "Probe", files: storageProbeProject() });
  check("installs a project", installed.ok === true, installed.ok ? installed.app.id : installed.hint);
  if (!installed.ok) return finish();

  const appId = installed.app.id;
  check(
    "reads name and capabilities from app.json",
    installed.app.name === "Probe" && installed.app.capabilities.includes("storage"),
    `name=${installed.app.name} caps=${JSON.stringify(installed.app.capabilities)}`,
  );

  // --- the actual question: does the origin have storage? -----------------
  const partition = `persist:lykn-app-${appId}`;
  appProtocol.bind(session.fromPartition(partition));

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: appHost.PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      partition,
    },
  });

  const probe = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: "timed out waiting for the app to report" }), 20000);
    win.webContents.on("console-message", (_e, level, message) => {
      if (level >= 2) console.log(`    [app console] ${message}`);
    });
    win.webContents.once("did-finish-load", async () => {
      try {
        // Poll rather than assume: the probe runs in an effect after mount.
        for (let i = 0; i < 40; i += 1) {
          const out = await win.webContents.executeJavaScript("window.__probe || null");
          if (out) {
            clearTimeout(timer);
            resolve(out);
            return;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        clearTimeout(timer);
        resolve({ error: "the app never produced a report" });
      } catch (err) {
        clearTimeout(timer);
        resolve({ error: err.message });
      }
    });
    win.loadURL(appProtocol.urlFor(appId));
  });

  if (probe.error) {
    check("app boots and reports", false, probe.error);
  } else {
    check("app boots and reports", true, `origin ${probe.origin}`);
    check("the app origin is a secure context", probe.isSecureContext === "true", probe.isSecureContext);
    check("localStorage works inside the app", probe.localStorage === "yes", String(probe.localStorage));
    check("IndexedDB works inside the app", probe.indexedDB === "ok", String(probe.indexedDB));
    check("lykn.db round-trips through the bridge", probe.bridge === "ok", String(probe.bridge));
    check(
      "an ungranted capability is refused",
      probe.ungrantedVault === "refused",
      String(probe.ungrantedVault),
    );
  }

  // The bridge writes to SQLite, so the row must be visible from main — this
  // is what makes app data part of the user's backup rather than browser state.
  const fromMain = localStore.apps.dataGet(appId, "notes", "n1");
  check(
    "data written by the app is in the user's database",
    fromMain?.title === "from inside the app",
    JSON.stringify(fromMain),
  );

  // --- localStorage is redirected into SQLite, not left in the browser ----
  const shimmed = localStore.apps.dataGet(appId, appBridge.LOCAL_STORAGE_COLLECTION, "probe");
  check("localStorage is redirected into the app's database", shimmed === "yes", JSON.stringify(shimmed));

  if (!win.isDestroyed()) win.destroy();

  // --- isolation ----------------------------------------------------------
  const other = await appHost.installApp({ title: "Other", files: storageProbeProject() });
  check(
    "a second app gets a different origin",
    other.ok && other.app.id !== appId,
    other.ok ? other.app.id : other.hint,
  );
  if (other.ok) {
    check(
      "the second app cannot see the first app's data",
      localStore.apps.dataGet(other.app.id, "notes", "n1") === null,
      "isolated",
    );
  }

  // --- editing an app again, and installing the result --------------------
  // What "Edit in Build mode" rests on: reinstalling under the same id has to
  // be an update, not a second app. If this regressed, editing would silently
  // strand the user's data in an app they can no longer see.
  const beforeCount = localStore.apps.listApps().length;
  const edited = await appHost.installApp({
    id: appId,
    title: "Probe",
    files: [
      { path: "app.json", content: JSON.stringify({ name: "Probe", capabilities: ["storage"] }) },
      { path: "App.jsx", content: `export default function App() { return <div>edited</div>; }` },
    ],
  });
  check("reinstalling under the same id succeeds", edited.ok === true, edited.ok ? "" : edited.hint);
  check(
    "editing updates the app rather than adding another",
    edited.ok && edited.app.id === appId && localStore.apps.listApps().length === beforeCount,
    `${localStore.apps.listApps().length} apps (was ${beforeCount})`,
  );
  check(
    "everything the app had saved survives the edit",
    localStore.apps.dataGet(appId, "notes", "n1")?.title === "from inside the app",
    JSON.stringify(localStore.apps.dataGet(appId, "notes", "n1")),
  );
  check(
    "the previous build is kept to roll back to",
    localStore.apps.listVersions(appId).length > 0,
    `${localStore.apps.listVersions(appId).length} version(s)`,
  );
  check(
    "the new source is what the app now serves",
    (localStore.apps.readFile(appId, "App.jsx") || "").includes("edited"),
    "",
  );

  // --- the libraries a real generated app uses ----------------------------
  // Compiling is not enough: these are separate IIFE bundles that must find
  // React on the global and agree with the shim's export list at run time.
  const rich = await appHost.installApp({
    title: "Rich",
    files: [
      {
        path: "App.jsx",
        content: `import React from "react";
import { Check } from "lucide-react";
import { LineChart, Line } from "recharts";
import { motion } from "framer-motion";
export default function App() {
  return (
    <motion.div animate={{ opacity: 1 }}>
      <Check />
      <LineChart width={100} height={80} data={[{ v: 1 }, { v: 2 }]}><Line dataKey="v" /></LineChart>
    </motion.div>
  );
}`,
      },
    ],
  });
  check("an app using icons, charts, and motion installs", rich.ok === true, rich.hint || "");
  if (rich.ok) {
    const verdict = await appHost.verifyApp(rich.app.id, { timeoutMs: 15000 });
    check(
      "…and renders them without error",
      verdict.ok === true,
      verdict.errors.map((e) => e.message).join(" | ").slice(0, 200),
    );
  }

  // --- verify loop --------------------------------------------------------
  // A false failure is worse than no verification: it would send the build
  // agent editing an app that already works.
  const healthy = await appHost.rebuildAndVerify(appId);
  check("a healthy app passes verification", healthy.ok === true, healthy.hint || "");

  const broken = await appHost.installApp({
    title: "Broken",
    files: [{ path: "App.jsx", content: `export default function App() { throw new Error("boom"); }` }],
  });
  if (broken.ok) {
    const verdict = await appHost.verifyApp(broken.app.id, { timeoutMs: 12000 });
    check(
      "the verify pass catches an app that crashes on mount",
      verdict.ok === false && verdict.errors.length > 0,
      verdict.errors.map((e) => e.message).join(" | ").slice(0, 160),
    );
  } else {
    check("the verify pass catches an app that crashes on mount", false, "install failed");
  }

  // A project that does not compile must never reach the dock.
  const uncompilable = await appHost.installApp({
    title: "Uncompilable",
    files: [{ path: "App.jsx", content: `import x from "some-missing-package";` }],
  });
  check(
    "an app that cannot compile is refused at install",
    uncompilable.ok === false,
    String(uncompilable.hint || "").slice(0, 120),
  );

  finish();
}

function finish() {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  try {
    localStore.shutdown();
  } catch {
    /* shutting down anyway */
  }
  app.exit(failed.length ? 1 : 0);
}

// The probe window is destroyed mid-run, and Electron's default response to
// "no windows left" is to quit — which would end the script before the
// isolation and verify checks ever run.
app.on("window-all-closed", () => {});

app.whenReady().then(() =>
  main().catch((err) => {
    console.error("\nverify failed:", err);
    app.exit(1);
  }),
);
