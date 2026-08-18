#!/usr/bin/env node
/**
 * Live-site benchmark: what tracker blocking is actually worth.
 *
 * The local harness cannot answer this. Its pages contain no trackers, so
 * blocking has nothing to block and the measured benefit is exactly zero —
 * which is a true statement about synthetic pages and a useless one about the
 * web. Real sites are the only place the blocklist can be evaluated.
 *
 * The trade is noise. Timing over the public internet moves with DNS, CDN
 * routing, edge cache state and time of day, so the timing columns here are
 * indicative at best. **Requests blocked and bytes saved are not** — those are
 * counted, not timed, and are stable across runs. Read those as the result and
 * the milliseconds as colour.
 *
 * Usage: node native/bench/run-live.mjs [--iterations 3]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PACKAGE = join(HERE, "..", "LYKNAgent");

const args = process.argv.slice(2);
const iterIndex = args.indexOf("--iterations");
const ITERATIONS = iterIndex >= 0 ? Number(args[iterIndex + 1]) : 3;

/// Public homepages that carry ordinary third-party analytics and advertising.
/// Kept short and hit a handful of times — enough to measure, not enough to be
/// a burden on anyone's origin.
const SITES = [
  "https://www.theguardian.com/international",
  "https://www.cnn.com",
  "https://www.bbc.com/news",
  "https://www.imdb.com",
  "https://www.reddit.com",
];

const CONFIGS = [
  { id: "chromium", label: "Chromium (Electron 42), no blocking", kind: "electron", args: [] },
  { id: "wk-plain", label: "WKWebView, no blocking", kind: "swift", args: ["--plain"] },
  { id: "wk-hardened", label: "WKWebView, tracker blocking on", kind: "swift", args: ["--hardened"] },
];

function runSamples(config, iterations) {
  const common = ["--iterations", String(iterations), "--urls", SITES.join(","), "--warm"];
  const command =
    config.kind === "electron"
      ? join(REPO, "node_modules", ".bin", "electron")
      : join(PACKAGE, ".build", "debug", "LYKNBench");
  const commandArgs =
    config.kind === "electron"
      ? [join(HERE, "electron-bench.cjs"), ...common]
      : [...config.args, ...common];

  return new Promise((resolve, reject) => {
    const proc = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const samples = [];
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), 180000);

    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("SAMPLE ")) {
          try {
            samples.push(JSON.parse(line.slice(7)));
          } catch {
            /* dropped sample */
          }
        }
      }
    });
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("exit", () => {
      clearTimeout(timer);
      if (!samples.length) {
        reject(new Error(`${config.id} produced no samples\n${stderr.slice(0, 600)}`));
        return;
      }
      resolve(samples);
    });
  });
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values) {
  const clean = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return clean.length ? quantile(clean, 0.5) : NaN;
}

function fmt(value, width = 8) {
  return (Number.isFinite(value) ? value.toFixed(1) : "—").padStart(width);
}

const all = {};
for (const config of CONFIGS) all[config.id] = [];

for (let round = 0; round < ITERATIONS; round++) {
  const order = round % 2 === 0 ? CONFIGS : [...CONFIGS].reverse();
  for (const config of order) {
    process.stdout.write(`round ${round + 1}/${ITERATIONS}  ${config.id} … `);
    try {
      const samples = await runSamples(config, 1);
      all[config.id].push(...samples);
      process.stdout.write(`${samples.length} samples\n`);
    } catch (error) {
      process.stdout.write(`FAILED: ${error.message.split("\n")[0]}\n`);
    }
  }
}

process.stdout.write("\nLive sites. Requests and bytes are counted and reliable;\n");
process.stdout.write("milliseconds cross the public internet and are indicative only.\n\n");

const hosts = [...new Set(Object.values(all).flat().map((s) => s.page))].sort();
const report = { generatedAt: new Date().toISOString(), sites: SITES, iterations: ITERATIONS, byHost: {} };

process.stdout.write(
  `${"site".padEnd(24)}${"config".padEnd(14)}${"reqs".padStart(6)}${"KB".padStart(9)}${"fcp".padStart(9)}${"load".padStart(9)}\n`,
);

for (const host of hosts) {
  report.byHost[host] = {};
  for (const config of CONFIGS) {
    const rows = all[config.id].filter((s) => s.page === host);
    if (!rows.length) continue;
    const reqs = median(rows.map((s) => s.resources));
    const kb = median(rows.map((s) => s.bytes)) / 1024;
    const fcp = median(rows.map((s) => s.fcp));
    const load = median(rows.map((s) => s.load));
    report.byHost[host][config.id] = { reqs, kb, fcp, load, n: rows.length };
    process.stdout.write(
      `${host.padEnd(24)}${config.id.padEnd(14)}${fmt(reqs, 6)}${fmt(kb, 9)}${fmt(fcp, 9)}${fmt(load, 9)}\n`,
    );
  }
  process.stdout.write("\n");
}

// Headline: what the blocklist removed, WKWebView-with vs WKWebView-without,
// so the engine is held constant and only the rules vary.
const plainReqs = median(all["wk-plain"].map((s) => s.resources));
const hardReqs = median(all["wk-hardened"].map((s) => s.resources));
const plainKB = median(all["wk-plain"].map((s) => s.bytes)) / 1024;
const hardKB = median(all["wk-hardened"].map((s) => s.bytes)) / 1024;

process.stdout.write("── Blocking effect (same engine, rules on vs off)\n");
process.stdout.write(`  median requests   ${fmt(plainReqs)} → ${fmt(hardReqs)}`);
process.stdout.write(
  Number.isFinite(plainReqs) && plainReqs > 0
    ? `  (${(((hardReqs - plainReqs) / plainReqs) * 100).toFixed(0)}%)\n`
    : "\n",
);
process.stdout.write(`  median KB         ${fmt(plainKB)} → ${fmt(hardKB)}`);
process.stdout.write(
  Number.isFinite(plainKB) && plainKB > 0
    ? `  (${(((hardKB - plainKB) / plainKB) * 100).toFixed(0)}%)\n`
    : "\n",
);

report.blocking = { plainReqs, hardReqs, plainKB, hardKB };
mkdirSync(join(HERE, "results"), { recursive: true });
writeFileSync(join(HERE, "results", "live.json"), JSON.stringify({ ...report, raw: all }, null, 2));
process.stdout.write(`\nraw samples → ${join(HERE, "results", "live.json")}\n`);
