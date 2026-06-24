/**
 * Smoke test for browser control — run on macOS with a browser tab open.
 * Usage: node scripts/test-browser-act.mjs
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  collectBrowserInteractables,
  executeBrowserActions,
  sanitizePlanActions,
} = require("../electron/browserAct.cjs");

function runOsascript(script, timeout = 8000) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: String((stderr || "") + " " + (err.message || "")).trim() });
        return;
      }
      resolve({ out: String(stdout || "").trim() });
    });
  });
}

async function getActiveBrowserTarget() {
  const pickScript = `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  set runningApps to name of (every process whose background only is false)
end tell
set allBrowsers to {"Safari", "Safari Technology Preview", "Google Chrome", "Google Chrome Canary", "Brave Browser", "Microsoft Edge", "Arc", "Chromium", "Opera", "Vivaldi", "Dia", "Sidekick"}
if frontApp is in allBrowsers then return frontApp
repeat with b in allBrowsers
  if (b as string) is in runningApps then return (b as string)
end repeat
return ""
`;
  const pick = await runOsascript(pickScript);
  if (pick.error || !pick.out) return null;
  const appName = pick.out;
  const tabExpr = /^Safari/.test(appName) ? "current tab" : "active tab";
  const r = await runOsascript(
    `tell application "${appName}" to get URL of ${tabExpr} of front window`,
  );
  if (r.error || !/^https?:\/\//i.test(r.out)) return null;
  return { appName, url: r.out };
}

async function testApiPlan(items, intent) {
  const res = await fetch("http://localhost:3001/api/desktop/browser-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({
      intent,
      url: "https://example.com",
      title: "Example",
      items: items.slice(0, 20),
    }),
  });
  return { status: res.status, body: await res.text() };
}

async function main() {
  console.log("=== Browser control smoke test ===\n");

  // 1. Health
  try {
    const h = await fetch("http://localhost:3001/api/health");
    console.log(`1. API health: ${h.ok ? "OK" : "FAIL"} (${h.status})`);
  } catch (e) {
    console.log("1. API health: FAIL — is `npm run server` running on :3001?");
  }

  // 2. Route exists (expect 401 without real token)
  try {
    const r = await fetch("http://localhost:3001/api/desktop/browser-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ intent: "test", items: [{ selector: "#x", label: "x" }] }),
    });
    const msg = r.status === 401 ? "route exists (401 auth required)" : `status ${r.status}`;
    console.log(`2. browser-plan endpoint: ${msg}`);
  } catch (e) {
    console.log("2. browser-plan endpoint: FAIL —", e.message);
  }

  // 3. Browser detection
  const target = await getActiveBrowserTarget();
  if (!target) {
    console.log("3. Browser target: SKIP — no browser with http(s) tab found");
  } else {
    console.log(`3. Browser target: ${target.appName} → ${target.url.slice(0, 60)}…`);
  }

  // 4. Scan interactables
  if (target) {
    const scan = await collectBrowserInteractables(runOsascript, target.appName);
    if (scan.error) {
      console.log(`4. Page scan: FAIL (${scan.error})`);
      if (scan.message) console.log(`   ${scan.message.slice(0, 120)}`);
    } else {
      const n = scan.page?.items?.length || 0;
      console.log(`4. Page scan: OK — ${n} interactables on "${scan.page?.title || "?"}"`);
      if (n > 0) {
        console.log("   Sample:", scan.page.items.slice(0, 3).map((i) => i.label || i.tag).join(", "));
      }

      // 5. API plan (needs auth — just report scan readiness)
      const selectors = new Set(scan.page.items.map((i) => i.selector));
      const fakePlan = sanitizePlanActions(
        [{ type: "click", selector: scan.page.items[0]?.selector, label: scan.page.items[0]?.label }],
        selectors,
      );
      console.log(`5. Action sanitizer: ${fakePlan.length ? "OK" : "SKIP"} (selector validation)`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
