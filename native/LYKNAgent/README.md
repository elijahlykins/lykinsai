# LYKN Agent (native macOS)

The LYKN browser agent running on WKWebView instead of Electron/Chromium.

Design rationale, action-by-action analysis and the record of what degraded:
[`docs/WKWEBVIEW_ACTUATION_MIGRATION.md`](../../docs/WKWEBVIEW_ACTUATION_MIGRATION.md).

macOS 14+ (`WKWebsiteDataStore(forIdentifier:)`).

## Layout

```
Sources/
  LYKNAgentCore/     the brain — knows nothing about WebKit
    AgentLoop.swift          observe → decide → act → verify → recover
    Executor.swift           next action + the consequence/approval gates
    Verifier.swift           deterministic evidence first, model second
    BrowserController.swift  THE SEAM: the only way the brain touches a browser
    Resources/agent/**       instruction markdown (progressive disclosure)
  LYKNWebKit/        the browser — the whole WKWebView port
    Resources/lykn-runtime.js    isolated-world observation + JS actuation
    Resources/lykn-page-shim.js  page-world: shadow roots, in-flight counter
    ActuationBackend.swift       JS-synthetic vs NSEvent, and what that costs
    WebKitBrowserController.swift
  LYKNAgentApp/      SwiftUI shell
```

The split that matters: **everything in `LYKNAgentCore` is unchanged in spirit
from the Electron build**, because the agent only ever talked to the browser
through `BrowserController`. `LYKNWebKit` is the part that was rewritten.

> **Drift warning.** `Sources/LYKNAgentCore/Resources/agent/` is a *copy* of
> `electron/browser-agent/agent/` (plus that directory's `AGENTS.md`). Both
> builds read their own copy, so an instruction edit made in one place silently
> does not apply to the other. Until the Electron path is retired, edit both —
> or make one a symlink of the other.

## Build and test

```bash
swift build
```

```bash
swift test
```

```bash
swift run LYKNAgentApp
```

The app reads `LYKN_API_BASE` and `LYKN_AGENT_TOKEN` from the environment; the
model endpoint is the LYKN server's structured route, so no provider keys live
here.

## Two actuation backends, and why

`NativeEventBackend` (default) posts `NSEvent`s so **web content sees trusted
events** — which is what makes file pickers, `window.open`, fullscreen and
anything else gated on transient user activation work at all. No TCC prompt,
sandbox-safe, App Store viable.

`JSSyntheticBackend` synthesizes DOM events instead. It works everywhere and
needs no entitlement, but `isTrusted` is false and everything in the list above
stops working. It is the floor, not a choice: per the migration doc, every
action must have a JS path.

`CGEvent` posting is available behind `NativeEventBackend.advancedMode`. It
fixes hover desync but **requires the Accessibility grant even to drive our own
window**, so it is off by default and needs an explicit, explained opt-in.

## Privacy posture

HTTPS upgrade (WebKit-managed, with fallback), third-party tracker blocking via
`WKContentRuleList`, and WebKit's default third-party cookie blocking — see
`Sources/LYKNWebKit/PrivacyConfiguration.swift`, which documents why a
`make-https` rule and a blanket `block-cookies` rule are both deliberately
absent.

## Performance

Faster than the Electron build it replaces on every measured page: FCP −75%,
load −75%, cold start −25%. Method, per-page tables, what the agent runtime
costs, and the two caveats the headline hides are in
[`native/bench/README.md`](../bench/README.md).

## Actuation coverage

```bash
node native/bench/server.mjs &   # serves the local form/fixture pages
swift run LYKNActuate
```

Drives the real controller through observation, trusted clicking, the typing
ladder, form controls, the coordinate chain and the staleness contract on
example.com, Wikipedia, DuckDuckGo and Hacker News. 30/30.

This is the integration gate, not `swift test`: WKWebView's content process
does not start in SPM's headless xctest host, where `callAsyncJavaScript` never
returns. Anything needing a live web view runs here, under a real
`NSApplication`.

## Status

Builds, passes 112 unit tests (~0.2s), and passes 30/30 live actuation checks.
Not yet attempted: login-gated flows, canvas apps, file upload, drag and IME —
see §9 and §11 of the migration doc.
