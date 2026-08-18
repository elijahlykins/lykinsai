#!/usr/bin/env node
/**
 * Deterministic page server for the engine benchmark.
 *
 * Everything is generated from a fixed seed and served over plain localhost
 * HTTP. That is the point: no TLS handshake, no DNS, no CDN, no network
 * variance — so a difference between two runs is a difference between two
 * rendering engines, not a difference between two moments on the internet.
 *
 * Live-site numbers are more realistic and far noisier; `run.mjs --live` can
 * do those separately, and the report keeps them apart.
 */
import http from "node:http";
import { deflateSync } from "node:zlib";

const PORT = Number(process.env.BENCH_PORT || 8787);

/** Deterministic PRNG so every run serves byte-identical pages. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  "india", "juliett", "kilo", "lima", "mike", "november", "oscar", "papa",
];

function words(rand, n) {
  let out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(" ");
}

/** A tiny valid PNG (1x1, opaque) — enough to be a real image decode. */
const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005050201a1a4a8d40000000049454e44ae426082",
  "hex",
);

const pages = {
  /** Baseline: minimal document, one stylesheet, one script. */
  simple(rand) {
    return html({
      title: "simple",
      head: `<link rel="stylesheet" href="/asset/style.css?n=1"><script src="/asset/app.js?n=1" defer></script>`,
      body: `<h1>simple</h1><p>${words(rand, 40)}</p>`,
    });
  },

  /** Layout and style resolution over a large tree. */
  "dom-heavy"(rand) {
    let rows = [];
    for (let i = 0; i < 2500; i++) {
      rows.push(
        `<li class="row r${i % 12}"><span class="k">${i}</span><span class="v">${words(rand, 6)}</span></li>`,
      );
    }
    return html({
      title: "dom-heavy",
      head: `<link rel="stylesheet" href="/asset/style.css?n=2">`,
      body: `<h1>dom-heavy</h1><ul class="list">${rows.join("")}</ul>`,
    });
  },

  /** Connection handling and the resource pipeline: 60 subresources. */
  "resource-heavy"(rand) {
    let tags = [];
    for (let i = 0; i < 30; i++) tags.push(`<img src="/asset/pixel.png?n=${i}" width="8" height="8" alt="">`);
    for (let i = 0; i < 15; i++) tags.push(`<script src="/asset/tiny.js?n=${i}"></script>`);
    let links = [];
    for (let i = 0; i < 15; i++) links.push(`<link rel="stylesheet" href="/asset/tiny.css?n=${i}">`);
    return html({
      title: "resource-heavy",
      head: links.join(""),
      body: `<h1>resource-heavy</h1>${tags.join("")}<p>${words(rand, 30)}</p>`,
    });
  },

  /** Parse + JIT + execute. Real arithmetic and string work, not a sleep. */
  "js-heavy"(rand) {
    return html({
      title: "js-heavy",
      head: `<script src="/asset/work.js?n=1"></script>`,
      body: `<h1>js-heavy</h1><div id="out"></div><p>${words(rand, 20)}</p>`,
    });
  },

  /** Control page for form actuation: the element kinds real no-login pages
   * do not conveniently offer together (notably a <select>). */
  form(rand) {
    return html({
      title: "form",
      head: `<link rel="stylesheet" href="/asset/style.css?n=3">`,
      body: `<h1>form</h1>
<form id="f" method="get" action="/form">
  <label for="name">Full name</label>
  <input id="name" name="name" type="text" placeholder="Full name">
  <label for="colour">Favourite colour</label>
  <select id="colour" name="colour">
    <option value="">Choose…</option>
    <option value="red">Red</option>
    <option value="green">Green</option>
    <option value="blue">Blue</option>
  </select>
  <label for="notes">Notes</label>
  <textarea id="notes" name="notes" rows="4"></textarea>
  <label><input id="agree" name="agree" type="checkbox"> Agree to terms</label>
  <button id="submit" type="submit">Submit form</button>
</form>
<div id="echo"></div>`,
    });
  },

  /** Fixture exercising every element kind the injected runtime reports on:
   * disabled control, internally-scrolling container, editable fields. */
  fixture(rand) {
    return html({
      title: "fixture",
      head: `<style>button{display:block;width:180px;height:32px;margin:8px 0}</style>`,
      body: `<h1>Fixture heading</h1>
<p>Some visible prose about browsers.</p>
<button id="alpha">Alpha button</button>
<button id="beta" disabled>Beta button</button>
<input id="name" type="text" placeholder="Full name">
<textarea id="notes">keep the first part</textarea>
<label><input id="agree" type="checkbox"> Agree</label>
<div id="panel" tabindex="0" aria-label="Scrollable panel" style="height:60px;overflow:auto"><div style="height:400px">tall</div></div>`,
    });
  },

  /** Selector matching against a large stylesheet. */
  "css-heavy"(rand) {
    let nodes = [];
    for (let i = 0; i < 800; i++) {
      nodes.push(`<div class="c${i % 200} d${i % 37}"><b>${i}</b> ${words(rand, 4)}</div>`);
    }
    return html({
      title: "css-heavy",
      head: `<link rel="stylesheet" href="/asset/big.css?n=1">`,
      body: `<h1>css-heavy</h1>${nodes.join("")}`,
    });
  },
};

function html({ title, head, body }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;
}

const assets = {
  "/asset/style.css": () =>
    [
      "body{font:14px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;color:#222}",
      "h1{font-size:24px;margin:0 0 16px}",
      ".list{list-style:none;margin:0;padding:0}",
      ".row{display:flex;gap:12px;padding:4px 8px;border-bottom:1px solid #eee}",
      ".row .k{width:60px;color:#888;font-variant-numeric:tabular-nums}",
      ".row .v{flex:1}",
      ...Array.from({ length: 12 }, (_, i) => `.r${i}{background:hsl(${i * 30} 80% 97%)}`),
    ].join("\n"),

  "/asset/big.css": () => {
    const rand = mulberry32(99);
    let out = [];
    for (let i = 0; i < 200; i++) {
      out.push(
        `.c${i}{color:hsl(${Math.floor(rand() * 360)} 60% 35%);padding:2px 4px}`,
        `.c${i} b{font-weight:${400 + (i % 5) * 100}}`,
        `.c${i}:hover{background:hsl(${Math.floor(rand() * 360)} 90% 96%)}`,
      );
    }
    for (let i = 0; i < 37; i++) out.push(`.d${i}{border-left:2px solid hsl(${i * 9} 70% 70%)}`);
    return out.join("\n");
  },

  "/asset/tiny.css": () => ".tiny{display:block}",
  "/asset/app.js": () => `document.documentElement.dataset.app='1';`,
  "/asset/tiny.js": () => `void 0;`,

  /** Deterministic CPU work: string building, sorting, math. ~100-200ms —
   * large enough that JIT and GC differences are visible above the noise. */
  "/asset/work.js": () => `
(function(){
  function rng(s){return function(){s|=0;s=(s+0x6D2B79F5)|0;var t=Math.imul(s^(s>>>15),1|s);
    t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296;};}
  var r=rng(1234), acc=0, arr=[];
  for(var i=0;i<4000000;i++){ acc += Math.sqrt(r()*1000) | 0; }
  for(var j=0;j<200000;j++){ arr.push(((r()*1e9)|0).toString(36)); }
  arr.sort();
  var s='';
  for(var k=0;k<50000;k++){ s += arr[k].slice(0,3); }
  var out=document.getElementById('out');
  if(out) out.textContent = 'acc='+acc+' len='+s.length;
})();
`,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  // Caching is the variable under test, not a thing to leave to chance:
  // every response is explicitly uncacheable so a "cold" run really is cold
  // in both engines.
  const noStore = {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
  };

  if (path === "/asset/pixel.png") {
    res.writeHead(200, { "Content-Type": "image/png", ...noStore });
    res.end(PNG_1X1);
    return;
  }
  if (assets[path]) {
    const type = path.endsWith(".css") ? "text/css" : "application/javascript";
    res.writeHead(200, { "Content-Type": type, ...noStore });
    res.end(assets[path]());
    return;
  }
  const name = path.replace(/^\//, "") || "simple";
  if (pages[name]) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...noStore });
    res.end(pages[name](mulberry32(name.length * 7717)));
    return;
  }
  if (path === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404, noStore);
  res.end("not found");
});

export const PAGES = Object.keys(pages);

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`bench-server listening on http://127.0.0.1:${PORT}\n`);
  process.stdout.write(`pages: ${PAGES.join(", ")}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
