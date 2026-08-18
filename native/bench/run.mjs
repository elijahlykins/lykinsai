#!/usr/bin/env node
/**
 * Benchmark orchestrator.
 *
 * Runs the WKWebView and Chromium runners over the same local page set and
 * reports medians. Three choices here exist to stop the result being an
 * artefact of how it was measured:
 *
 * 1. **Interleaved, order-alternating rounds.** Running all of A then all of B
 *    lets thermal state and background load drift between them. Rounds
 *    alternate A/B then B/A so any drift falls on both engines equally.
 * 2. **Median and IQR, never mean.** One GC pause or one Spotlight wakeup
 *    moves a mean and does not move a median.
 * 3. **Configurations that separate the claims.** A blocking browser loads
 *    pages faster by not loading things; that is a real user benefit but it is
 *    not an engine result. `wk-plain-noruntime` is the like-for-like engine
 *    comparison; `wk-hardened` is what users would actually get.
 *
 * Usage:  node native/bench/run.mjs [--rounds 5] [--per-round 2]
 */
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const PACKAGE = join(HERE, "..", "LYKNAgent");
const PORT = Number(process.env.BENCH_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
}
const ROUNDS = flag("rounds", 5);
const PER_ROUND = flag("per-round", 2);
const PAGES = ["simple", "dom-heavy", "resource-heavy", "js-heavy", "css-heavy"];

const CONFIGS = [
  {
    id: "chromium",
    label: "Chromium (Electron 42)",
    kind: "electron",
    args: [],
    note: "what we ran before",
  },
  {
    id: "wk-plain-noruntime",
    label: "WKWebView, engine only",
    kind: "swift",
    args: ["--plain", "--no-runtime"],
    note: "like-for-like engine comparison",
  },
  {
    id: "wk-plain-runtime",
    label: "WKWebView + agent runtime",
    kind: "swift",
    args: ["--plain"],
    note: "cost of the injected instrumentation",
  },
  {
    id: "wk-hardened",
    label: "WKWebView, shipped config",
    kind: "swift",
    args: ["--hardened"],
    note: "runtime + HTTPS upgrade + tracker blocking",
  },
];

// ── process helpers ─────────────────────────────────────────────────────────

function startServer() {
  const proc = spawn("node", [join(HERE, "server.mjs")], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, BENCH_PORT: String(PORT) },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 10000);
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve(proc);
      }
    });
  });
}

function runSamples(config, iterations) {
  const common = [
    "--base", BASE,
    "--iterations", String(iterations),
    "--pages", PAGES.join(","),
    // Steady-state navigation: one view/window reused across loads, with the
    // server sending `no-store` so every response is still fetched fresh.
    // Rebuilding the view per iteration would measure process and session
    // setup, which is not what happens when a person clicks a link.
    "--warm",
  ];

  let command;
  let commandArgs;
  if (config.kind === "electron") {
    command = join(REPO, "node_modules", ".bin", "electron");
    commandArgs = [join(HERE, "electron-bench.cjs"), ...common];
  } else {
    command = join(PACKAGE, ".build", "debug", "LYKNBench");
    commandArgs = [...config.args, ...common];
  }

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const proc = spawn(command, commandArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
    });
    const samples = [];
    let buffer = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith("SAMPLE ")) {
          try {
            samples.push(JSON.parse(line.slice(7)));
          } catch {
            /* a malformed line is a dropped sample, not a failed run */
          }
        }
      }
    });
    proc.stderr.on("data", (chunk) => (stderr += chunk));
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (samples.length === 0) {
        reject(new Error(`${config.id} produced no samples (exit ${code})\n${stderr.slice(0, 800)}`));
        return;
      }
      resolve({ samples, processMs: Date.now() - started });
    });
  });
}

// ── stats ───────────────────────────────────────────────────────────────────

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values) {
  const clean = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (clean.length === 0) return { n: 0, median: NaN, p25: NaN, p75: NaN };
  return {
    n: clean.length,
    median: quantile(clean, 0.5),
    p25: quantile(clean, 0.25),
    p75: quantile(clean, 0.75),
  };
}

const METRICS = ["wallMs", "ttfb", "fcp", "dcl", "load"];

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(1).padStart(7) : "      —";
}

// ── main ────────────────────────────────────────────────────────────────────

const all = {};
for (const config of CONFIGS) all[config.id] = [];

const server = await startServer();
process.stdout.write(`server up on ${BASE}\n`);

try {
  for (let round = 0; round < ROUNDS; round++) {
    // Alternate direction each round so ordering bias cancels.
    const order = round % 2 === 0 ? CONFIGS : [...CONFIGS].reverse();
    for (const config of order) {
      process.stdout.write(`round ${round + 1}/${ROUNDS}  ${config.id} … `);
      const { samples } = await runSamples(config, PER_ROUND);
      all[config.id].push(...samples);
      process.stdout.write(`${samples.length} samples\n`);
    }
  }
} finally {
  server.kill("SIGTERM");
}

// ── cold start ──────────────────────────────────────────────────────────────
//
// Steady-state navigation is the common case, but first-paint-after-launch is
// what a user feels when the app opens. Measured separately because it is a
// different question with a different answer: it includes runtime startup,
// which is exactly where a system engine and a bundled one differ most.

const coldStart = {};
const coldServer = await startServer().catch(() => null);
try {
  for (const config of CONFIGS) {
    const durations = [];
    for (let i = 0; i < 3; i++) {
      try {
        const { processMs } = await runSamples({ ...config, }, 1);
        durations.push(processMs);
      } catch {
        /* a failed launch is excluded rather than counted as zero */
      }
    }
    coldStart[config.id] = summarize(durations);
  }
} finally {
  coldServer?.kill("SIGTERM");
}

// ── report ──────────────────────────────────────────────────────────────────

const report = { generatedAt: new Date().toISOString(), rounds: ROUNDS, perRound: PER_ROUND, pages: PAGES, configs: {} };

process.stdout.write("\n");
process.stdout.write("Median milliseconds, lower is better.\n");
process.stdout.write(
  "Steady-state navigation: warm process, uncached responses (no-store), local HTTP.\n\n",
);

const header = ["page", ...METRICS].map((h) => h.padStart(h === "page" ? 16 : 8)).join("  ");

for (const config of CONFIGS) {
  const samples = all[config.id];
  process.stdout.write(`── ${config.label}  (${config.note})\n`);
  process.stdout.write(`${header}\n`);
  report.configs[config.id] = { label: config.label, note: config.note, pages: {} };

  for (const page of PAGES) {
    const forPage = samples.filter((s) => s.page === page);
    const cells = [page.padStart(16)];
    const pageReport = {};
    for (const metric of METRICS) {
      const stats = summarize(forPage.map((s) => s[metric]));
      cells.push(fmt(stats.median).padStart(8));
      pageReport[metric] = stats;
    }
    report.configs[config.id].pages[page] = pageReport;
    process.stdout.write(`${cells.join("  ")}\n`);
  }

  // Per page, not pooled: these pages carry 1 to 60 subresources, so a pooled
  // median just reports whichever page count happens to sit in the middle.
  const perPage = PAGES.map((page) => {
    const forPage = samples.filter((s) => s.page === page);
    return `${page}=${summarize(forPage.map((s) => s.resources)).median ?? "—"}`;
  });
  report.configs[config.id].resourcesPerPage = perPage.join(" ");
  process.stdout.write(`  subresources: ${perPage.join("  ")}\n\n`);
}

// Headline: like-for-like engine comparison, then the shipped configuration.
function overall(configId, metric) {
  return summarize(all[configId].map((s) => s[metric])).median;
}

process.stdout.write("── Headline (all pages pooled)\n");
for (const metric of METRICS) {
  const chromium = overall("chromium", metric);
  const engine = overall("wk-plain-noruntime", metric);
  const shipped = overall("wk-hardened", metric);
  const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b > 0 ? ((a - b) / b) * 100 : NaN);
  const enginePct = pct(engine, chromium);
  const shippedPct = pct(shipped, chromium);
  process.stdout.write(
    `${metric.padStart(8)}  chromium ${fmt(chromium)}   engine-only ${fmt(engine)} (${enginePct >= 0 ? "+" : ""}${enginePct.toFixed(0)}%)   shipped ${fmt(shipped)} (${shippedPct >= 0 ? "+" : ""}${shippedPct.toFixed(0)}%)\n`,
  );
}
process.stdout.write("\nNegative % = WKWebView faster than Chromium.\n");

process.stdout.write("\n── Cold start (process launch → one page loaded → exit, median of 3)\n");
for (const config of CONFIGS) {
  const stats = coldStart[config.id] || { median: NaN };
  process.stdout.write(`${config.id.padStart(20)}  ${fmt(stats.median)} ms\n`);
}
report.coldStart = coldStart;

mkdirSync(join(HERE, "results"), { recursive: true });
const outPath = join(HERE, "results", "latest.json");
writeFileSync(outPath, JSON.stringify({ ...report, raw: all }, null, 2));
process.stdout.write(`\nraw samples → ${outPath}\n`);
