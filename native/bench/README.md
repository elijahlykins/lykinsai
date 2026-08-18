# Engine benchmark: WKWebView vs Chromium

Compares the new WKWebView browser against the Electron/Chromium one it
replaces, in **non-agentic mode** — plain page loads, no agent running.

```bash
node native/bench/run.mjs --rounds 10 --per-round 3   # local, deterministic
node native/bench/run-live.mjs --iterations 3          # live sites, blocking effect
```

Requires `swift build` in `native/LYKNAgent` first (the runner is
`.build/debug/LYKNBench`).

## Method

| | |
|---|---|
| Pages | 5 synthetic pages served from localhost: `simple`, `dom-heavy` (2500 nodes), `resource-heavy` (60 subresources), `js-heavy` (~35ms of real CPU work), `css-heavy` (600-rule stylesheet) |
| Transport | Plain local HTTP with `no-store` on every response — no DNS, no TLS, no CDN, no cache |
| Mode | Steady state: one window/web view reused across loads, so the numbers are navigation speed rather than process startup |
| Warm-up | One load per process, discarded |
| Sampling | Interleaved rounds with alternating order (A/B then B/A), so thermal drift lands on both engines equally |
| Statistic | Median of 30 samples per page per config, with IQR retained in `results/latest.json` |
| Measurement | The same Navigation Timing script in both engines, sampled after first-contentful-paint has actually been recorded |

Four configurations, because "faster" is three different claims:

- **chromium** — Electron 42.4.1, what we ran before.
- **wk-plain-noruntime** — WKWebView with no agent scripts and no blocking.
  The like-for-like engine comparison.
- **wk-plain-runtime** — plus the injected agent runtime. Isolates what the
  instrumentation costs an ordinary page load.
- **wk-hardened** — plus HTTPS upgrade and tracker blocking. What ships.

A blocking browser loads pages faster by *not loading things*. That is a real
user benefit and not an engine result, so the two are never mixed.

## Results

Environment: macOS 26.4, Xcode 26.4, Electron 42.4.1, Apple silicon.
Raw samples in `results/latest.json`.

### First contentful paint — median ms, lower is better

| page | Chromium | WKWebView | |
|---|---:|---:|---|
| simple | 48 | **4** | −92% |
| dom-heavy | 84 | **46** | −45% |
| resource-heavy | 36 | **13** | −64% |
| js-heavy | 72 | **34** | −53% |
| css-heavy | 36 | **9** | −75% |

### Load event — median ms

| page | Chromium | WKWebView | |
|---|---:|---:|---|
| simple | 23.6 | **3.0** | −87% |
| dom-heavy | 31.5 | **6.0** | −81% |
| resource-heavy | 23.3 | **22.0** | −6% |
| js-heavy | 56.1 | **33.0** | −41% |
| css-heavy | 11.4 | **4.0** | −65% |

### Pooled

| metric | Chromium | engine only | shipped config |
|---|---:|---:|---:|
| TTFB | 4.2 | **1.0** (−76%) | 1.0 (−76%) |
| FCP | 52.0 | **13.0** (−75%) | 13.0 (−75%) |
| DOMContentLoaded | 20.7 | **6.0** (−71%) | 10.0 (−52%) |
| Load | 24.0 | **6.0** (−75%) | 11.0 (−54%) |
| Wall clock | 33.4 | **23.5** (−30%) | 23.9 (−29%) |
| Cold start | 984 | **734** (−25%) | 732 (−26%) |

**WKWebView is faster on every page and every metric.** JS execution is the
narrowest margin that still favours it (`js-heavy`, −41% on load), which is
what you would expect — that page is mostly JavaScriptCore versus V8, and V8 is
not far behind. The wide margins are in paint and load-event timing.

### What the agent runtime costs

Injecting the isolated-world runtime into every frame, measured as wall clock:

| page | without | with | cost |
|---|---:|---:|---:|
| simple | 5.4 | 6.1 | +0.7 ms |
| dom-heavy | 46.9 | 52.5 | +5.6 ms |
| resource-heavy | 23.5 | 23.6 | +0.1 ms |
| js-heavy | 35.0 | 36.4 | +1.4 ms |
| css-heavy | 10.5 | 12.1 | +1.6 ms |

Under 2ms except on a 2500-node DOM, where the document-start capture of native
references costs ~5ms. Adding HTTPS upgrade and tracker blocking on top is
within noise (`wk-hardened` vs `wk-plain-runtime`).

## Two caveats that matter

**1. Chromium's `dom-heavy` is bimodal, and the median hides it.**

Raw wall-clock samples, sorted:

```
chromium:  31 36 37 38 38 38 39 43 50 50 56 58 59 59 59 60 71 96
           187 188 192 192 192 193 193 193 212 212 214 215
wkwebview: 45 45 45 45 45 45 45 46 46 46 46 47 47 47 47 47 47 48
           48 48 48 50 50 50 51 55 57 57 58 58
```

Chromium has a ~38ms fast path — **faster than WKWebView's 47ms** — and a
~190ms slow path it lands in about a third of the time. WKWebView never leaves
a 45–58ms band. So on large DOMs the honest statement is not "WKWebView is
faster"; it is *"Chromium is faster when it wins and much slower when it
doesn't, and WKWebView is consistent."* For an agent that waits on page settle
before every observation, the tight distribution is worth more than the better
best case — but it is not the clean win the median implies.

Earlier low-sample runs of this same benchmark reported the opposite
(WKWebView slower on `dom-heavy`); that reading came from ~8 samples landing
mostly in Chromium's fast mode and does not survive at n=30. Anything under
~30 samples per cell on this page is noise.

**2. Wall clock flatters WKWebView.** It is measured host-side from `load()`
to the completion callback, and on the Electron side that includes `loadURL`'s
IPC round-trip. The in-page metrics (TTFB, FCP, DCL, load) are recorded by the
engine itself and are the trustworthy comparison. They agree with the wall
clock on direction, which is why the conclusion stands.

## Live sites: what blocking is worth

The local pages contain no trackers, so blocking measures exactly zero there.
`run-live.mjs` loads five public news/media homepages with the same engine and
only the rules varying.

| | requests | |
|---|---:|---|
| WKWebView, no blocking | 75 | |
| WKWebView, blocking on | 67 | **−11%** |

Per site, blocking removed 9 requests on cnn.com (92→83) and 9 on bbc.com
(76→67), with load-event times dropping on both. Two caveats: `transferSize` is
0 for opaque cross-origin responses without `Timing-Allow-Origin`, so
bytes-saved is not measurable this way; and one site (imdb.com) returned only 2
resources in every engine, meaning it did not really load under automation and
contributes nothing. Live timings cross the public internet and are indicative
only — **request counts are the reliable figure here**, and they are counted,
not timed.

## Reproducing

Results are written to `results/latest.json` (local) and `results/live.json`
(live), including every raw sample, so the medians above can be recomputed or
challenged.
