/**
 * Smoke test for hosting an installed app inside the desktop.
 *
 * `verify:apps` proves an app works in a window of its own. This proves the
 * thing the draggable desktop window rests on: that the same app, embedded as a
 * <webview> inside the Studio page, still gets its own origin, its own preload
 * bridge, and its own storage. An <iframe> cannot do this — subframes don't run
 * a preload — so if this fails the window has to host native views instead.
 *
 * Run: npm run verify:app-webview
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { app, protocol, session, BrowserWindow } = require("electron");

const appProtocol = require("../electron/appProtocol.cjs");

protocol.registerSchemesAsPrivileged([appProtocol.schemeRegistration()]);

const localStore = require("../electron/localStore/index.cjs");
const appBridge = require("../electron/appBridge.cjs");
const appHost = require("../electron/appHost.cjs");

const checks = [];
function check(name, passed, detail = "") {
  checks.push({ name, passed, detail });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

function probeProject() {
  return [
    {
      path: "app.json",
      content: JSON.stringify({ name: "Embedded", description: "webview probe", capabilities: ["storage"] }),
    },
    {
      path: "App.jsx",
      content: `import React, { useEffect, useState } from "react";

export default function App() {
  const [state, setState] = useState("running");
  useEffect(() => {
    (async () => {
      const out = {};
      out.origin = String(window.location.origin);
      out.isSecureContext = String(window.isSecureContext);
      out.hasBridge = String(!!window.lykn);
      try { localStorage.setItem("k", "v"); out.localStorage = localStorage.getItem("k"); }
      catch (e) { out.localStorage = "THREW: " + e.message; }
      try {
        await lykn.db.set("notes", "n1", { title: "from the embedded app" });
        const back = await lykn.db.get("notes", "n1");
        out.bridge = back && back.title === "from the embedded app" ? "ok" : "mismatch";
      } catch (e) { out.bridge = "THREW: " + e.message; }
      window.__probe = out;
      setState("done");
    })();
  }, []);
  return <div style={{ padding: 24, font: "16px system-ui" }}>embedded: {state}</div>;
}`,
    },
  ];
}

async function main() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "lykn-webview-verify-"));
  console.log(`electron ${process.versions.electron}`);
  console.log(`userData: ${userDataPath}\n`);

  localStore.configure(userDataPath);
  appProtocol.bind(session.defaultSession);
  appBridge.bind();

  const installed = await appHost.installApp({ title: "Embedded", files: probeProject() });
  check("installs the app", installed.ok === true, installed.ok ? installed.app.id : installed.hint);
  if (!installed.ok) return finish();
  const appId = installed.app.id;

  const partition = `persist:lykn-app-${appId}`;
  appProtocol.bind(session.fromPartition(partition));

  // The host page stands in for Studio: a normal renderer that embeds the app.
  // The tag deliberately asks for nothing but a src — main is what pins the
  // preload and the partition, so this also proves markup can't opt out of them.
  const hostFile = path.join(userDataPath, "host.html");
  fs.writeFileSync(
    hostFile,
    `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#222">
<webview id="guest" src="${appProtocol.urlFor(appId)}"
         style="position:absolute;left:40px;top:40px;width:600px;height:400px"></webview>
<webview id="foreign" src="https://example.com/" style="width:10px;height:10px"></webview>
</body>`,
  );

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    // `sandbox: true` matches the real Studio window — a sandboxed embedder is
    // the case that actually has to work.
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Same guard main.cjs installs on the Studio window.
  let refusedForeign = "not tried";
  win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const id = appProtocol.appIdFromOrigin(params.src || "");
    if (!id) {
      refusedForeign = "refused";
      event.preventDefault();
      return;
    }
    delete webPreferences.preloadURL;
    webPreferences.preload = appHost.PRELOAD;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    params.partition = appHost.partitionFor(id);
  });

  let attached = null;
  win.webContents.on("did-attach-webview", (_e, guest) => {
    attached = guest;
  });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ error: "timed out waiting for the embedded app" }), 25000);
    win.webContents.once("did-finish-load", async () => {
      for (let i = 0; i < 60; i += 1) {
        if (attached && !attached.isLoading()) {
          try {
            const out = await attached.executeJavaScript("window.__probe || null");
            if (out) {
              clearTimeout(timer);
              resolve(out);
              return;
            }
          } catch {
            /* guest still settling */
          }
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      clearTimeout(timer);
      resolve({ error: attached ? "the embedded app never reported" : "no webview attached" });
    });
    win.loadFile(hostFile);
  });

  check("the app attaches as a webview", !!attached);
  if (result.error) {
    check("the embedded app boots and reports", false, result.error);
  } else {
    check("the embedded app boots and reports", true, `origin ${result.origin}`);
    check("keeps its own app origin", result.origin === `lykn-app://${appId}`, String(result.origin));
    check("is a secure context", result.isSecureContext === "true", String(result.isSecureContext));
    check("gets the preload bridge", result.hasBridge === "true", String(result.hasBridge));
    check("localStorage works", result.localStorage === "v", String(result.localStorage));
    check("lykn.db round-trips", result.bridge === "ok", String(result.bridge));
  }

  check("a non-app URL is refused attachment", refusedForeign === "refused", refusedForeign);

  const fromMain = localStore.apps.dataGet(appId, "notes", "n1");
  check(
    "the embedded app's write is in SQLite",
    fromMain && fromMain.title === "from the embedded app",
    JSON.stringify(fromMain),
  );

  if (!win.isDestroyed()) win.destroy();
  finish();
}

function finish() {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  app.exit(failed.length ? 1 : 0);
}

app.on("window-all-closed", () => {});
app.whenReady().then(() =>
  main().catch((err) => {
    console.error(err);
    app.exit(1);
  }),
);
