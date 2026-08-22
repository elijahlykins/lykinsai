/**
 * Smoke test for change detection against a real DOM.
 *
 * Two halves of this run in the page and cannot be unit-tested: the activity
 * monitor that decides when the page has stopped working, and the catalog's
 * reading of ARIA state. Both are hand-built JavaScript strings, so a syntax
 * error in either would fail silently — the monitor would never install and
 * settling would go back to guessing, or the catalog would return nothing and
 * every page would read as empty.
 *
 * Each case clicks something and asks the two questions that matter: did the
 * settle step wait for the page's response, and could the diff see it.
 *
 * Run: npm run smoke:settle
 */

const http = require("node:http");
const { app, BrowserWindow } = require("electron");
const ownedBrowserAct = require("../ownedBrowserAct.cjs");
const { buildSnapshot, diffSnapshots, hasObservableChange } = require("../browser-agent/browser/snapshot.cjs");

/**
 * Pages are served over HTTP rather than as `data:` URLs because two of the
 * cases are about requests: one that takes time to answer and one that never
 * answers. A `data:` URL resolves instantly and would quietly turn both into
 * something else.
 */
const routes = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/slow") {
    setTimeout(() => res.end("report"), 400);
    return;
  }
  if (url.pathname === "/hang") {
    // Held open for the life of the test, like a long-poll or an SSE stream.
    return;
  }
  const html = routes.get(url.pathname);
  if (!html) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

let origin = "";
let routeSeq = 0;

const page = (title, body, script = "") => {
  const route = `/case${++routeSeq}`;
  routes.set(
    route,
    `<!doctype html><html><head><title>${title}</title><style>
  body{font:16px system-ui;margin:0;padding:24px}
  button{font:inherit;padding:8px 14px;margin:4px}
  #out{margin-top:16px}
</style></head><body>
<h1>${title}</h1>
${body}
<div id="out"></div>
<script>${script}</script>
</body></html>`,
  );
  return route;
};

const CASES = [
  {
    // The baseline: an instant response. Nothing here should be slow.
    name: "a click that renders immediately",
    expect: { change: /New elements/, maxMs: 500 },
    url: page(
      "Instant",
      `<button id="go">Show details</button>`,
      `document.getElementById('go').onclick=function(){
         document.getElementById('out').innerHTML='<button>Hide details</button>';
       };`,
    ),
  },
  {
    // The case that produced most of the false failures: the response is a
    // request, and the DOM sits untouched until it resolves. Nothing about the
    // page looks busy in the meantime.
    name: "a click that fetches, then renders",
    expect: { change: /New elements/, minMs: 350 },
    url: page(
      "Fetching",
      `<button id="go">Load report</button>`,
      `document.getElementById('go').onclick=function(){
         fetch('/slow').then(function(r){return r.text();}).then(function(t){
           document.getElementById('out').innerHTML='<button>Download '+t+'</button>';
         });
       };`,
    ),
  },
  {
    // A debounced or animated update, arriving after the DOM has already gone
    // quiet once. This is what the loop's second look exists for; settling
    // alone is allowed to miss it.
    name: "a click whose update is queued behind a timer",
    expect: { change: /New elements/, allowMissed: true },
    url: page(
      "Debounced",
      `<button id="go">Search</button>`,
      `document.getElementById('go').onclick=function(){
         setTimeout(function(){
           document.getElementById('out').innerHTML='<button>Result 1</button>';
         },900);
       };`,
    ),
  },
  {
    // A menu opening: same label, same page text, nothing new to read. The
    // whole change is one attribute.
    name: "a click that only flips aria-expanded",
    expect: { change: /"Filters" opened/, maxMs: 900 },
    url: page(
      "Menu",
      `<button id="go" aria-expanded="false">Filters</button>`,
      `document.getElementById('go').onclick=function(){
         this.setAttribute('aria-expanded','true');
       };`,
    ),
  },
  {
    // A custom checkbox: no DOM `checked` property to read, only aria-checked.
    name: "a click that ticks a custom checkbox",
    expect: { change: /"Email me" ticked/, maxMs: 900 },
    url: page(
      "Checkbox",
      `<div id="go" role="checkbox" aria-checked="false" tabindex="0">Email me</div>`,
      `document.getElementById('go').onclick=function(){
         this.setAttribute('aria-checked','true');
       };`,
    ),
  },
  {
    // Deleting one of several identical rows: the set of labels on the page is
    // exactly the same afterwards.
    name: "a click that removes one of five identical rows",
    expect: { change: /"remove" 5→4/, maxMs: 900 },
    url: page(
      "Rows",
      `<ul id="rows"><li><span>Item</span><button id="go">Remove</button></li>${
        "<li><span>Item</span><button>Remove</button></li>".repeat(4)
      }</ul>`,
      `document.getElementById('go').onclick=function(){this.closest('li').remove();};`,
    ),
  },
  {
    // A page that never stops mutating must not cost the full budget on every
    // action, or every click on a site with a carousel gets slower. (Its ticker
    // does change the page text, so only the timing is asserted here.)
    name: "a click on a page that animates forever",
    expect: { maxMs: 1200 },
    url: page(
      "Animated",
      `<button id="go">Nothing happens</button><div id="tick"></div>`,
      `setInterval(function(){
         document.getElementById('tick').textContent='t'+Date.now();
       },16);
       document.getElementById('go').onclick=function(){};`,
    ),
  },
  {
    // A mail or chat app holds a request open for the whole session. Waiting on
    // it would spend the entire budget on every action for the whole run.
    name: "a click on a page holding a long-poll open",
    expect: { change: null, maxMs: 600 },
    url: page(
      "Long poll",
      `<button id="go">Nothing happens</button>`,
      `fetch('/hang').catch(function(){});
       document.getElementById('go').onclick=function(){};`,
    ),
  },
];

async function observe(wc) {
  const [catalog, context] = await Promise.all([
    ownedBrowserAct.getDOMCatalog(wc),
    ownedBrowserAct.getPageContext(wc),
  ]);
  return buildSnapshot({
    url: context?.url || "",
    title: context?.title || "",
    text: context?.text || "",
    catalog: catalog?.items || [],
  });
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ width: 1200, height: 800, show: false });
  let failures = 0;
  for (const testCase of CASES) {
    await win.loadURL(`${origin}${testCase.url}`).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    const wc = win.webContents;

    // Observe exactly as the loop does — which is also what arms the monitor.
    const before = await observe(wc);
    if (!before.elements.length) {
      console.log(`FAIL  ${testCase.name}\n      the catalog came back empty — the collector is broken`);
      failures += 1;
      continue;
    }
    const target = before.elements.find((e) => e.raw?.selector === "#go") || before.elements[0];
    await ownedBrowserAct.runAction(wc, { type: "click", selector: target.raw.selector }, []);

    const started = Date.now();
    await ownedBrowserAct.waitForDomSettle(wc, 3000);
    const settleMs = Date.now() - started;
    let diff = diffSnapshots(before, await observe(wc));

    // The loop's second look, for updates that land after the page has already
    // gone quiet once.
    let neededSecondLook = false;
    if (!hasObservableChange(diff)) {
      await new Promise((r) => setTimeout(r, 700));
      const later = diffSnapshots(before, await observe(wc));
      if (hasObservableChange(later)) {
        neededSecondLook = true;
        diff = later;
      }
    }

    const want = testCase.expect;
    let ok = true;
    let why = "";
    if (want.change === null && hasObservableChange(diff)) {
      ok = false;
      why = "expected no change";
    } else if (want.change instanceof RegExp && !want.change.test(diff.summary)) {
      ok = false;
      why = `expected ${want.change}`;
    }
    if (ok && want.minMs && settleMs < want.minMs) {
      ok = false;
      why = `settled in ${settleMs}ms without waiting for the response (wanted >=${want.minMs}ms)`;
    }
    if (ok && want.maxMs && settleMs > want.maxMs) {
      ok = false;
      why = `settling took ${settleMs}ms (wanted <=${want.maxMs}ms)`;
    }
    if (ok && neededSecondLook && !want.allowMissed) {
      ok = false;
      why = "settling missed it; only the second look caught it";
    }
    if (!ok) failures += 1;
    console.log(
      `${ok ? "ok  " : "FAIL"}  ${testCase.name}\n      settled in ${settleMs}ms` +
        `${neededSecondLook ? " (+ second look)" : ""} — ${diff.summary.slice(0, 120)}` +
        (why ? `\n      ${why}` : ""),
    );
  }
  console.log(failures ? `\n${failures} case(s) failed` : "\nall cases behaved as intended");
  server.close();
  app.exit(failures ? 1 : 0);
});
