/**
 * Chromium/Electron side of the engine benchmark.
 *
 * Mirrors Sources/LYKNBench/main.swift exactly: same pages, same iteration
 * count, same measurement script, same cold/warm handling, same JSONL output.
 * Anywhere the two runners differ is a place the comparison lies, so the
 * differences are kept to the minimum the two APIs force.
 *
 * Run via run.mjs, not directly.
 */
const { app, BrowserWindow, session } = require("electron");

// Byte-identical to `measureJS` in the Swift runner.
const MEASURE_JS = `
(function () {
  var nav = (performance.getEntriesByType('navigation') || [])[0] || {};
  var paint = performance.getEntriesByType('paint') || [];
  var res = performance.getEntriesByType('resource') || [];
  var fcp = 0;
  for (var i = 0; i < paint.length; i++) {
    if (paint[i].name === 'first-contentful-paint') fcp = paint[i].startTime;
  }
  var bytes = 0;
  for (var j = 0; j < res.length; j++) bytes += (res[j].transferSize || 0);
  return {
    ttfb: nav.responseStart || 0,
    domInteractive: nav.domInteractive || 0,
    dcl: nav.domContentLoadedEventEnd || 0,
    load: nav.loadEventEnd || 0,
    fcp: fcp,
    resources: res.length,
    bytes: bytes
  };
})()
`;

// Byte-identical intent to `awaitPaintJS` in the Swift runner.
const AWAIT_PAINT_JS = `
new Promise(function (resolve) {
  function has() {
    var p = performance.getEntriesByType('paint') || [];
    for (var i = 0; i < p.length; i++) {
      if (p[i].name === 'first-contentful-paint') return true;
    }
    return false;
  }
  if (has()) return resolve(true);
  var done = false;
  var finish = function () { if (!done) { done = true; resolve(true); } };
  try {
    new PerformanceObserver(function () { if (has()) finish(); })
      .observe({ type: 'paint', buffered: true });
  } catch (e) {}
  setTimeout(finish, 400);
})
`;

function parseArgs() {
  const argv = process.argv.slice(2);
  const options = {
    base: "http://127.0.0.1:8787",
    pages: ["simple", "dom-heavy", "resource-heavy", "js-heavy", "css-heavy"],
    iterations: 10,
    cold: true,
    urls: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") options.base = argv[++i];
    else if (argv[i] === "--iterations") options.iterations = Number(argv[++i]);
    else if (argv[i] === "--pages") options.pages = argv[++i].split(",");
    else if (argv[i] === "--urls") options.urls = argv[++i].split(",");
    else if (argv[i] === "--warm") options.cold = false;
    else if (argv[i] === "--cold") options.cold = true;
  }
  return options;
}

const options = parseArgs();
let partitionCounter = 0;

function makeWindow() {
  // A fresh partition per iteration on cold runs is the Chromium analogue of
  // WKWebsiteDataStore.nonPersistent() — no cache, no reusable connections.
  const partition = options.cold
    ? `bench-cold-${partitionCounter++}`
    : "persist:bench-warm";

  return new BrowserWindow({
    width: 1280,
    height: 800,
    show: true, // Chromium throttles offscreen/occluded renderers too.
    webPreferences: {
      partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The Electron build did not block trackers, so neither does this side.
      // The Swift runner's `--plain` mode is the like-for-like counterpart.
    },
  });
}

function emit(sample) {
  process.stdout.write(`SAMPLE ${JSON.stringify(sample)}\n`);
}

async function loadOnce(win, url) {
  const started = process.hrtime.bigint();
  await win.loadURL(url);
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Match the Swift runner: loadEventEnd is written during the load event.
  await new Promise((resolve) => setTimeout(resolve, 50));
  try {
    await win.webContents.executeJavaScript(AWAIT_PAINT_JS, true);
  } catch {
    /* paint never arrived within budget; the sample still stands */
  }
  let metrics = {};
  try {
    metrics = await win.webContents.executeJavaScript(MEASURE_JS, true);
  } catch {
    metrics = {};
  }
  return { wallMs, metrics };
}

app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

app.whenReady().then(async () => {
  let win = null;

  // One discarded load, matching the Swift runner: first-window creation and
  // renderer spin-up cost is not page speed.
  win = makeWindow();
  try {
    await loadOnce(win, `${options.base}/simple`);
  } catch {
    /* warm-up failure is not a result */
  }

  const targets = options.urls.length
    ? options.urls.map((u) => ({ page: new URL(u).host, url: u }))
    : options.pages.map((p) => ({ page: p, url: `${options.base}/${p}` }));

  for (const { page, url } of targets) {
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      if (options.cold || !win) {
        if (win) win.destroy();
        win = makeWindow();
      }
      const { wallMs, metrics } = await loadOnce(win, url);
      emit({
        engine: "chromium",
        page,
        iteration,
        wallMs,
        hardened: false,
        runtime: false,
        cold: options.cold,
        ...metrics,
      });
    }
  }
  if (win) win.destroy();
  process.stdout.write("DONE\n");
  app.exit(0);
});

app.on("window-all-closed", () => {});
