/**
 * Capture the raw snapshot inputs the Chromium agent sees on a page.
 *
 * Drives the real actuator (electron/ownedBrowserAct.cjs) rather than a
 * reimplementation, so whatever the shipping agent would observe — including
 * the site-specific injections, e.g. the `docs_editor_body` element and the
 * canvas-rendered warning on Google Docs — lands in the JSON.
 *
 *   npx electron native/parity/chromium-capture.cjs <url> <out.json>
 */
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow } = require("electron");

const ROOT = path.resolve(__dirname, "..", "..");
const actuator = require(path.join(ROOT, "electron", "ownedBrowserAct.cjs"));

const target = process.argv.find((a) => a.startsWith("http"));
const out = process.argv[process.argv.length - 1];

if (!target || !out.endsWith(".json")) {
  console.error("usage: electron chromium-capture.cjs <url> <out.json>");
  process.exit(2);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false });
  const wc = win.webContents;

  await actuator.navigate(wc, target);
  try {
    await actuator.waitForLoad(wc, 8000);
  } catch {
    /* best effort, same as the agent's settle */
  }
  await new Promise((r) => setTimeout(r, 3000));

  const [catalogRes, contextRes] = await Promise.all([
    actuator.getDOMCatalog(wc),
    actuator.getPageContext(wc),
  ]);

  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        url: contextRes?.url || catalogRes?.url || wc.getURL(),
        title: contextRes?.title || wc.getTitle(),
        catalog: catalogRes?.items || [],
        text: contextRes?.text || "",
        tabs: [{ id: "tab-1", url: wc.getURL(), title: wc.getTitle(), active: true }],
      },
      null,
      2,
    ),
  );
  console.log(`wrote ${out}: ${(catalogRes?.items || []).length} catalog items`);
  app.exit(0);
});
