# Prompt parity: what the agent actually sees

Renders the **complete round-one prompt** — system message, user message, and
the routing that produced them — from either browser stack, for any URL.

```bash
# WKWebView
swift build --package-path native/parity/ParityDump
./native/parity/ParityDump/.build/debug/ParityDump --capture https://example.com /tmp/wk.json
./native/parity/ParityDump/.build/debug/ParityDump --prompt "Summarise this page" /tmp/wk.json

# Chromium
npx electron native/parity/chromium-capture.cjs https://example.com /tmp/cr.json
node native/parity/chromium-prompt.cjs "Summarise this page" /tmp/cr.json
```

Diff the two outputs and you have the parity comparison in §9 —
element-for-element, module-for-module, byte-for-byte.

## Why it exists

§9 claims the two stacks present the same page model to `BrowserController`.
That claim is only checkable if you can see the real prompt from both, and the
prompt is assembled from a dozen places — the injected collector, the snapshot
formatter, the context router's progressive disclosure, the vision policy, the
task state. Describing it is not the same as producing it.

So both renderers call the **shipping** runtime rather than reimplementing it:
`contextRouter` / `ContextRouter`, `taskState` / `TaskStateStore`,
`visionPolicy` / `VisionPolicy`, `snapshot.cjs` / `SnapshotBuilder`. What they
print is the real model input.

This is how the §11 bug 4 user-agent defect was found: the two prompts for the
same Google Doc differed by an element and a warning banner, and chasing that
difference led to the missing `Version/` token.

## Capture format

`--capture` and `chromium-capture.cjs` write the same JSON shape
(`{url, title, catalog[], text, tabs[]}`), so **either renderer reads either
capture**. Verified: a WKWebView capture and a Chromium capture of example.com
render byte-identical prompts through `chromium-prompt.cjs`.

That matters because it separates the two things a difference could come from —
the *page* each engine was served, or the *pipeline* each stack runs it
through. Swap one and hold the other.

## Two honest caveats

- **The plan is a stand-in.** A real plan comes from the planner stage, which
  needs a model call. Both renderers substitute the same fixed four-step plan
  to stay offline and deterministic. Everything else is real.
- **`--capture` sleeps instead of settling.** `controller.settle()` deadlocks
  whenever its timeout path is taken (§11, bug 3), so a fixed 6-second delay
  stands in. Switch it back once that is fixed.

## Flags

| | |
|---|---|
| `--capture <url> <out.json>` | Capture raw snapshot inputs from a live page |
| `--prompt <goal> <captured.json>` | Render the full prompt from a capture |
| `--snapshot <url> [out.txt]` | Just the rendered snapshot block |
| `--ua <string>` | Capture as a different browser. This is how bug 4's 21-vs-28 element counts were measured |
