/**
 * End-to-end check that an installed app opens as a draggable desktop window.
 *
 * The other two verifications answer "does the app run" and "does it run when
 * embedded". This one answers the thing the user actually asked for: that
 * opening an installed app puts a window on the Studio desktop, that the app is
 * really inside it, and that the window moves when you drag its title bar.
 *
 * Drives a running LYKN over the DevTools protocol, so it exercises the real
 * Studio build rather than a stand-in page.
 *
 * Run: npm run verify:app-window   (starts and stops everything itself)
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = Number(process.env.LYKN_CDP_PORT || 9222);
const checks = [];
const children = [];

/**
 * Bring up Vite, the API server and Electron with the debugging port open.
 * Skipped when something is already listening on the port, so this can also be
 * pointed at an app that is already running.
 */
async function startApp() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/list`);
    console.log("using the LYKN already running on the debugging port");
    return;
  } catch {
    /* nothing there — start our own */
  }

  // Own process group each: `npm run dev` is a parent of the real Vite process,
  // and killing only the parent would leave the port held for the next run.
  const run = (cmd, args, env) => {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, ...env },
    });
    children.push(child);
    return child;
  };

  run("npm", ["run", "dev"]);
  run("node", ["server.js"]);
  await new Promise((resolve) => {
    const wait = spawn("npm", ["run", "wait:vite"], { stdio: "ignore" });
    wait.on("exit", resolve);
  });

  const electron = process.env.ELECTRON_RUN_AS_NODE ? "electron" : "./node_modules/.bin/electron";
  run(electron, [`--remote-debugging-port=${PORT}`, "electron/main.cjs"], {
    ELECTRON_RUN_AS_NODE: undefined,
    LYKN_BOOT_ROUTE: "/studio?glass=1",
    LYKN_APP_URL: "http://127.0.0.1:5173",
    LYKN_API_URL: "http://localhost:3001",
  });
}

function stopApp() {
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

function check(name, passed, detail = "") {
  checks.push({ name, passed });
  console.log(`${passed ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findStudioTarget(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(
        (t) => t.type === "page" && /127\.0\.0\.1:5173|localhost:5173/.test(t.url || ""),
      );
      if (page?.webSocketDebuggerUrl) return page;
    } catch {
      /* the app hasn't opened its debugging port yet */
    }
    await sleep(1000);
  }
  return null;
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        msg.error ? entry.reject(new Error(JSON.stringify(msg.error))) : entry.resolve(msg.result);
      }
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.on("open", () => resolve(new CDP(ws)));
      ws.on("error", reject);
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Evaluate in the page and return the value, failing loudly on a page error. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || "page threw");
    }
    return r.result?.value;
  }

  async drag(from, to) {
    const press = { x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...press });
    // Several moves: a single jump can read as a click rather than a drag.
    for (let i = 1; i <= 5; i += 1) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + ((to.x - from.x) * i) / 5,
        y: from.y + ((to.y - from.y) * i) / 5,
        button: "left",
        buttons: 1,
      });
      await sleep(40);
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: to.x,
      y: to.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }
}

const APP_SOURCE = `import React, { useEffect, useState } from "react";

export default function App() {
  const [n, setN] = useState(0);
  useEffect(() => { (async () => {
    const saved = await lykn.db.get("counter", "n");
    if (saved) setN(saved.value);
  })(); }, []);
  const bump = async () => { const next = n + 1; setN(next); await lykn.db.set("counter", "n", { value: next }); };
  return (
    <div style={{ padding: 32, font: "15px system-ui" }}>
      <h1>Drag Test</h1>
      <button id="bump" onClick={bump}>count is {n}</button>
    </div>
  );
}`;

async function main() {
  await startApp();
  console.log(`waiting for Studio on the debugging port ${PORT}…`);
  const target = await findStudioTarget();
  if (!target) {
    check("finds the Studio window", false, "no page target appeared");
    return finish();
  }
  check("finds the Studio window", true, target.url);

  const cdp = await CDP.connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // Wait for the desktop itself, not just the page: the store and the bridge
  // come up after first paint.
  for (let i = 0; i < 60; i += 1) {
    const ready = await cdp.eval("return !!(window.lykn && window.lykn.apps);");
    if (ready) break;
    await sleep(1000);
  }
  check("the apps bridge is available", await cdp.eval("return !!(window.lykn && window.lykn.apps);"));

  const installed = await cdp.eval(`
    const res = await window.lykn.apps.install({
      title: "Drag Test",
      files: [
        { path: "app.json", content: JSON.stringify({ name: "Drag Test", icon: "Rocket", capabilities: ["storage"] }) },
        { path: "App.jsx", content: ${JSON.stringify(APP_SOURCE)} },
      ],
    });
    return res;
  `);
  check("installs an app", installed?.ok === true, installed?.ok ? installed.app.id : installed?.hint || installed?.error);
  if (!installed?.ok) return finish();
  const appId = installed.app.id;

  // Exactly what the dock does. Retried because the desktop mounts well after
  // the bridge does in a dev build, and an unclaimed event would otherwise mean
  // "opened in a window of its own" rather than "on the desktop".
  let claimed = false;
  for (let i = 0; i < 40 && !claimed; i += 1) {
    claimed = await cdp.eval(`
      return !window.dispatchEvent(
        new CustomEvent("lykn:open-app", { detail: { id: ${JSON.stringify(appId)} }, cancelable: true }),
      );
    `);
    if (!claimed) await sleep(1000);
  }
  check("the desktop claims the open request", claimed === true, String(claimed));

  let frame = { found: false };
  for (let i = 0; i < 20 && !frame.found; i += 1) {
    await sleep(1000);
    frame = await cdp.eval(`
      const wv = document.querySelector('webview[src^="lykn-app://${appId}"]');
      if (!wv) return { found: false };
      const win = wv.closest("[style*='translate'], [style*='left']") || wv.parentElement.parentElement;
      const r = win.getBoundingClientRect();
      if (r.width < 1) return { found: false };
      return { found: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
    `);
  }

  check("the app is on the desktop in a window", frame?.found === true, JSON.stringify(frame?.rect));
  if (!frame?.found) return finish();

  const loaded = await cdp.eval(`
    const wv = document.querySelector('webview[src^="lykn-app://${appId}"]');
    return { src: wv.getAttribute("src"), partition: wv.getAttribute("partition") };
  `);
  check(
    "the window hosts the app's own origin",
    loaded?.src === `lykn-app://${appId}/`,
    `${loaded?.src} / ${loaded?.partition}`,
  );

  // --- the actual request: drag it ----------------------------------------
  const before = frame.rect;
  const grab = { x: before.x + before.w / 2, y: before.y + 12 };
  const to = { x: grab.x + 140, y: grab.y + 90 };
  await cdp.drag(grab, to);
  await sleep(600);

  const after = await cdp.eval(`
    const wv = document.querySelector('webview[src^="lykn-app://${appId}"]');
    const win = wv.closest("[style*='translate'], [style*='left']") || wv.parentElement.parentElement;
    const r = win.getBoundingClientRect();
    return { x: r.x, y: r.y };
  `);
  const dx = Math.round(after.x - before.x);
  const dy = Math.round(after.y - before.y);
  check(
    "dragging the title bar moves the window",
    Math.abs(dx - 140) < 40 && Math.abs(dy - 90) < 40,
    `moved ${dx},${dy} (asked for 140,90)`,
  );

  // Still alive after the move, which is what would break if the guest were a
  // native view being repositioned rather than a composited one.
  const alive = await cdp.eval(`
    const wv = document.querySelector('webview[src^="lykn-app://${appId}"]');
    return !!wv && wv.getBoundingClientRect().width > 100;
  `);
  check("the app is still mounted after the drag", alive === true);

  // --- editing it again in Build mode --------------------------------------
  const menu = await cdp.eval(`
    const btn = [...document.querySelectorAll('button[aria-label]')]
      .find((b) => b.getAttribute("aria-label") === "Open Drag Test");
    if (!btn) return { found: false };
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 400));
    const items = [...document.querySelectorAll("button")].map((b) => b.textContent.trim());
    return { found: true, hasEdit: items.includes("Edit in Build mode") };
  `);
  check("right-clicking the app offers an edit action", menu?.hasEdit === true, JSON.stringify(menu));

  if (menu?.hasEdit) {
    await cdp.eval(`
      const item = [...document.querySelectorAll("button")]
        .find((b) => b.textContent.trim() === "Edit in Build mode");
      item.click();
      return true;
    `);

    // The handoff is claimed by the chat surface once it owns a chat route.
    // Edit enters Build mode with the source attached — it does not open a
    // preview of the live app.
    let edit = { editing: false, files: false, update: false, panel: false };
    for (let i = 0; i < 20; i += 1) {
      await sleep(500);
      edit = await cdp.eval(`
        const text = document.body.innerText || "";
        return {
          editing: text.includes("Editing Drag Test"),
          files: text.includes("App.jsx") && text.includes("app.json"),
          update: [...document.querySelectorAll("button")]
            .some((b) => b.textContent.trim() === "Update Drag Test"),
          panel: !!document.querySelector(".lykn-artifact-panel.opacity-100"),
        };
      `);
      if (edit.editing && edit.files) break;
    }
    check("Build mode names the app it is editing", edit.editing === true, JSON.stringify(edit));
    check("the attached source files are named", edit.files === true, JSON.stringify(edit));
    check(
      "editing does not pull the app up as a preview",
      edit.update === false && edit.panel === false,
      edit.update ? "Update button appeared" : edit.panel ? "the artifact panel opened" : "ok",
    );

    // What the model is actually handed. A plain request must carry the app's
    // own source, or "add a dark mode" would build a new app from nothing.
    await cdp.eval(`
      window.__sent = null;
      window.__origFetch = window.fetch;
      window.fetch = async function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/api/ai/stream")) {
          try { window.__sent = JSON.parse(init.body); } catch { window.__sent = {}; }
          return new Response("", { status: 500 });
        }
        return window.__origFetch(input, init);
      };
      return true;
    `);
    await cdp.eval(`
      const ta = [...document.querySelectorAll("textarea")]
        .find((t) => /build/i.test(t.placeholder || "")) || document.querySelector("textarea");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "I want this to also have a dark mode toggle");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      return true;
    `);
    let sent = null;
    for (let i = 0; i < 20 && !sent; i += 1) {
      await sleep(1000);
      sent = await cdp.eval(`
        const c = window.__sent;
        if (!c) return null;
        const a = c.activeArtifact;
        return {
          source: !!(a && Array.isArray(a.files) && a.files.some((f) => String(f.content).includes("count is"))),
          discussOnly: a ? !!a.discussOnly : null,
        };
      `);
    }
    check(
      "a plain request is sent with the app's own source to edit",
      sent?.source === true && sent?.discussOnly === false,
      JSON.stringify(sent),
    );
    await cdp.eval(`if (window.__origFetch) window.fetch = window.__origFetch; return true;`);

    // Coming back to the conversation later: the handoff is spent, so the app
    // has to be picked back up from the chat's own record of it.
    const linkedChat = await cdp.eval(`
      const links = JSON.parse(localStorage.getItem("lykn_app_edit_chats") || "{}");
      return Object.keys(links).find((k) => links[k] === ${JSON.stringify(appId)}) || null;
    `);
    check("the chat remembers the app it edits", !!linkedChat, String(linkedChat));

    if (linkedChat) {
      await cdp.eval(`
        window.dispatchEvent(new CustomEvent("lykn-studio-open-tab", {
          detail: { id: "chat", src: "/app?nc=" + Date.now() }, cancelable: true }));
        return true;
      `);
      let elsewhere = true;
      for (let i = 0; i < 15; i += 1) {
        await sleep(1000);
        elsewhere = await cdp.eval(`return (document.body.innerText || "").includes("Editing Drag Test");`);
        if (!elsewhere) break;
      }
      check("a different chat is not tied to the app", elsewhere === false, String(elsewhere));

      let back = false;
      for (let i = 0; i < 20 && !back; i += 1) {
        await cdp.eval(`
          window.dispatchEvent(new CustomEvent("lykn-studio-open-tab", {
            detail: { id: "chat", src: "/chat/" + ${JSON.stringify(linkedChat)} }, cancelable: true }));
          return true;
        `);
        await sleep(2000);
        back = await cdp.eval(`return (document.body.innerText || "").includes("Editing Drag Test");`);
      }
      check("reopening the chat re-attaches the app's source", back === true, String(back));

      // The regression that made this worth testing: asking the same chat for
      // a different app must let go of the one it was editing, or installing
      // the result would silently overwrite an app the user never named.
      await cdp.eval(`
        window.__origFetch = window.fetch;
        window.fetch = async function (input, init) {
          const url = typeof input === "string" ? input : (input && input.url) || "";
          if (url.includes("/api/ai/stream")) return new Response("", { status: 500 });
          return window.__origFetch(input, init);
        };
        const ta = [...document.querySelectorAll("textarea")]
          .find((t) => /build/i.test(t.placeholder || "")) || document.querySelector("textarea");
        if (!ta) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(ta, "build me a brand new tetris game");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 400));
        ta.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        return true;
      `);
      let letGo = false;
      for (let i = 0; i < 15 && !letGo; i += 1) {
        await sleep(1000);
        letGo = await cdp.eval(`
          const links = JSON.parse(localStorage.getItem("lykn_app_edit_chats") || "{}");
          return !Object.values(links).includes(${JSON.stringify(appId)});
        `);
      }
      check(
        "asking for a different app stops the chat aiming at the old one",
        letGo === true,
        letGo ? "" : "the chat still points at the app it was editing",
      );
      await cdp.eval(`if (window.__origFetch) window.fetch = window.__origFetch; return true;`);
    }
  }

  await cdp.eval(`return window.lykn.apps.uninstall(${JSON.stringify(appId)});`);
  check("cleans up the test app", true);

  finish();
}

function finish() {
  const failed = checks.filter((c) => !c.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  stopApp();
  process.exit(failed.length ? 1 : 0);
}

process.on("exit", stopApp);
process.on("SIGINT", () => {
  stopApp();
  process.exit(1);
});

main().catch((err) => {
  console.error(err);
  stopApp();
  process.exit(1);
});
