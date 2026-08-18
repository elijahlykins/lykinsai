# Actuation Map: Electron `WebContentsView` → WKWebView

**Status:** implemented for macOS. The port lives in `native/LYKNAgent/`
(Swift package: `LYKNAgentCore`, `LYKNWebKit`, `LYKNAgentApp`). §9 records what
shipped, what degraded, and what is still open. The analysis in §1–§8 is
unchanged and remains the design rationale; where later work showed a
recommendation to be wrong, the correction is recorded in §9's scorecard rather
than edited back into §8. Seven of §8's nine recommendations were followed.

**Verified:** the actuation paths now run against live sites — 30/30 checks in
`swift run LYKNActuate` (§11), covering observation, trusted clicking, the
typing ladder, form controls, the coordinate chain and the staleness contract
on example.com, Wikipedia, DuckDuckGo and Hacker News. That run found and
fixed two real bugs that every unit test had passed straight through. A later
engine-parity capture (§9) drove both stacks over the same URLs and confirmed
the observation layer matches the Electron original field-for-field.

**Still not done:** no login-gated or canvas-based flow has been attempted —
nothing has met Gmail, Canva or Mailchimp, and file upload, drag and IME are
untested against a real page. §9's open list stands.

**Known defect:** `settle()` deadlocks whenever its timeout path is taken
(§11, bug 3). Unfixed, reproduced in isolation and live, and blocking — it
hangs the agent permanently on any page that is still loading when the budget
expires.

**Question it answers:** what would it take to run the LYKN browser agent on a
WKWebView-piloted browser instead of an Electron/Chromium one?

**Short answer:** the *brain* ports cleanly and the *observation* layer ports
cleanly — often better. The *actuation* layer does not. Every action LYKN
performs today via `webContents.executeJavaScript` has a direct WKWebView
equivalent; every action performed via `webContents.sendInputEvent`,
`webContents.insertText`, native clipboard verbs, or CDP has **no public
equivalent on either platform**. On macOS most of that gap is recoverable with
`NSEvent`/`CGEvent` synthesis at a distribution cost. On iOS it is not
recoverable at all.

Target floor assumed throughout: **macOS 14+ / iOS 17+** (needed for
`WKWebsiteDataStore(forIdentifier:)`).

---

## 1. Where the seam is today

```
model (JSON schema)                electron/browser-agent/runtime/model.cjs:47
  → executor.normalizeDecision     electron/browser-agent/runtime/executor.cjs:157
  → performAction switch           electron/browser-agent/index.cjs:618
  → controller.cjs                 (ref resolution, staleness, frame routing)
  → ownedBrowserAct.cjs            (Electron actuators)
  → webContents / webFrameMain / debugger / session
```

This is the good news. The agent runtime (`planner`, `executor`, `verifier`,
`taskState`, `memory`, `contextRouter`, `visionPolicy`) talks to the browser
**only** through `controller.cjs`'s action API — a design commitment already
stated in `electron/browser-agent/index.cjs:1-15`. A WKWebView port replaces
`controller.cjs` + `ownedBrowserAct.cjs` and leaves everything above untouched.

The agent-visible action vocabulary is the schema enum at
`electron/browser-agent/runtime/model.cjs:47-52`:

> `navigate, click, click_coord, drag, type, replace_text, select, scroll,
> go_back, go_forward, press_key, open_tab, close_tab, switch_tab, extract,
> wait, screenshot`

plus decision kinds `act | finish | ask_user | replan`.

---

## 2. Action-by-action map

Verdicts: **Direct** (public API, equivalent fidelity) · **Workaround**
(achievable with named degradation) · **macOS-only** · **Gap** (no path).

### `navigate` — Direct

| | |
|---|---|
| Today | `webContents.loadURL` (`ownedBrowserAct.cjs:1402`); settle via `isLoading` + `once("did-stop-loading")` (`:1316-1329`); `http(s)`/`about:blank` allowlist (`:1394`); `ERR_ABORTED` redirect recovery (`:1414`) |
| WKWebView | `load(URLRequest)`; settle via `WKNavigationDelegate.didFinish` / `didFailProvisionalNavigation` + KVO on `isLoading`/`estimatedProgress`. Allowlist moves into `decidePolicyFor navigationAction`, which is a *stronger* place for it — it also catches page-initiated navigations |
| Notes | `NSURLErrorCancelled` is the `ERR_ABORTED` analogue; same host-match recovery heuristic applies. `verifier.cjs:92-110` compares hosts and needs no change |

### `click` — **macOS-only for full fidelity; Workaround elsewhere**

This is the load-bearing loss.

| | |
|---|---|
| Today | `clickAtClientPoint` (`ownedBrowserAct.cjs:356`): `webContents.focus()`, then `sendInputEvent` `mouseMove`/`mouseDown`/`mouseUp` (`:369-377`) — **trusted** events. JS `el.click()` exists only as a *fallback* (`:2265`, `:10130`), then re-reinforced with input events (`:2269`) |
| WKWebView, iOS | JS synthesis only. Full pointer sequence — `pointerover, pointerenter, mouseover, mouseenter, pointermove, mousemove, pointerdown, mousedown, focus, pointerup, mouseup, click` with `bubbles/cancelable/composed: true`, correct `clientX/Y`, `screenX/Y`, `button`, `buttons`, `pointerId`, `pointerType`, `isPrimary` — then `el.click()`. `isTrusted === false` |
| WKWebView, macOS | `NSEvent.mouseEvent(with:location:...)` + `NSApp.postEvent(_:atStart:)` reaches `NSView.mouseDown:` and WebKit forwards it, so **web content sees trusted events**. No TCC prompt, sandbox-safe, App Store shippable. Caveats: the physical cursor doesn't move, `NSEvent.pressedMouseButtons` and `NSEvent.mouseLocation` don't update, so hover tracking and `:hover` CSS can desync. `CGEventPost(.cghidEventTap, …)` is fully faithful but **requires the Accessibility TCC grant even to drive your own window** — user-visible prompt, ungrantable programmatically, and routinely fatal in App Store review for automation-centric apps |

**What breaks under untrusted clicks** — this list should drive the port's
risk register, because it is not a fidelity nicety, it is a set of hard
failures:

- **Anything gated on transient user activation**: `<input type=file>` picker,
  `requestFullscreen()`, clipboard write, un-blocked `window.open()`, autoplay
  with audio, WebAuthn, Payment Request. Untrusted events neither consume nor
  grant activation.
- **Native form controls**: `<select>` menus (WebKit renders these natively —
  you cannot open one; you must set `.value` and dispatch `change`),
  date/time/color pickers, `<input type=range>` thumbs.
- **Bot detection**: Cloudflare Turnstile, PerimeterX, DataDome, Akamai read
  `isTrusted` and event-timing coherence. Expect to be flagged *more* than the
  current Electron build, not less.
- **Hit-testing**: you bypass the compositor, so the injected runtime must do
  its own topmost-element resolution (overlays, `pointer-events`, shadow
  boundaries). Today `resolvePointJs` (`ownedBrowserAct.cjs:1130`) already does
  this — it ports as-is.

The existing strict-target semantics (`element_obscured` /
`element_not_relocated`, `ownedBrowserAct.cjs:2213-2229`) survive unchanged;
they are pure JS hit-testing.

### `click_coord` — Workaround (coupled to snapshot metadata)

Today the 0–1000 normalized space is mapped to CSS pixels through
`lastScreenshotMeta` recorded at capture time
(`ownedBrowserAct.cjs:2323`: `{cssW, cssH, captureCssW, captureCssH, imgW,
imgH, dpr}`) via `mapNormCoordToClient` (`:274`).

**Screenshot and coordinate actuation are one subsystem, not two.** Any
WKWebView port must reproduce the same metadata from `takeSnapshot`, and the
conversion chain grows a term:

```
snapshot pixels
  ÷ (snapshotPixelWidth / viewportCSSWidth)   → CSS px (client coords)
  × pageZoom (macOS 11+) or scrollView.zoomScale (iOS)
  → NSView point
  → webView.convert(point, to: nil)           → window coords
  → window.convertPoint(toScreen:)            → screen coords (bottom-left)
  → y_cg = NSScreen.screens[0].frame.height - y_ns   (CGEvent wants top-left)
```

Get this wrong and `click_coord`/`drag` mis-aim silently — the same failure
mode the current `lastScreenshotMeta` design exists to prevent.

Label-snapping (`snapClientPointToCatalog`, `:308`) and the label-score-≥90
override (`:1900-1922`) are pure JS and port directly.

### `drag` — **macOS-only (partly), Gap on iOS**

| | |
|---|---|
| Today | Two paths. HTML5 DnD via `buildHtml5DragJs` with a shared `DataTransfer` (`ownedBrowserAct.cjs:466`, `:1859`); pointer drag via `dragByInput` (`:401`) — `mouseDown`, an eased 4–60-step `mouseMove` loop (`:435`), `mouseUp`. The stepping exists because **Chromium ignores single-jump synthetic drags** |
| WKWebView, macOS | Pointer drag needs real `NSEvent`s (same route as `click`). File-drop *into* a page can use `NSDraggingSession` via `beginDraggingSession(with:event:source:)` — WKWebView is an `NSDraggingDestination` — but that API **requires a real initiating `NSEvent`**, looping back to the same dependency |
| WKWebView, iOS | Not possible. `UIDragInteraction`/`UIDropInteraction` cannot be driven programmatically |
| Both | The HTML5-DnD JS path ports verbatim and works for pages that cooperatively read `dataTransfer`. Sortable lists / kanban that rely on the browser's own drag machinery do not |

### `type` — Workaround (reliable), with an IME gap

| | |
|---|---|
| Today | `typeWithFocusRetry` (`ownedBrowserAct.cjs:808`): real click to focus (`focusTypeTarget` `:611`), then **`webContents.insertText`** (`:980`), JS `fill` when native insert is unsuitable (`:983`), `sendRealKey("Enter")` (`:991`), read-back verification (`readTargetFieldValue` `:744`). Long text on Google Docs switches to **clipboard paste** (`pasteTextIntoPage` `:9238` → `clipboard.writeText` + `webContents.paste()`) |
| WKWebView | No `insertText`, no native `paste()`. Ranked replacement ladder: |

1. **Native value setter + events** — grab the setter off
   `HTMLInputElement.prototype` / `HTMLTextAreaElement.prototype` (defeats
   React's value tracker), then dispatch
   `new InputEvent('input', {bubbles:true, inputType:'insertText', data})`
   and `change` on blur. The workhorse; handles controlled inputs.
2. **`setRangeText(text, start, end, 'end')`** for caret-respecting partial
   edits.
3. **`document.execCommand('insertText', false, text)`** — deprecated but the
   *only* JS path producing a proper `beforeinput`/`input` pair with native
   undo-stack integration. This is what ProseMirror, Slate, Quill, Lexical and
   CodeMirror 6 actually want. **Prefer it for contenteditable.**
4. **Per-character `KeyboardEvent` synthesis** for editors that intercept keys
   (CodeMirror, Monaco, terminals). Must set `key`, `code`, legacy
   `keyCode`/`which`, `location`, modifiers. Synthetic keydown **never inserts
   text** — pair it with (1) or (3).
5. **macOS `NSEvent` keystrokes** — trusted, drives shortcut handlers.

**IME/composition is a genuine gap on both platforms.** No path drives a real
IME; `NSEvent` synthesis skips `interpretKeyEvents:` so composition never runs.
For CJK/emoji, set the value directly and fabricate
`compositionstart`/`update`/`end` — accepted by most editors, rejected by some.

The Docs/Sheets clipboard-paste strategy has no WKWebView equivalent
(clipboard write is itself user-activation-gated). Canvas-backed editors
therefore regress to option (4) plus vision, or to macOS trusted input.

### `replace_text` — Direct

Already pure `executeJavaScript` with no actuator involvement
(`controller.cjs:222-420`): prototype value setter, contenteditable fast path,
`TreeWalker` + `Range.deleteContents()/insertNode()` for cross-node matches.
Ports verbatim to `callAsyncJavaScript`. Frame routing changes only in how the
frame handle is obtained (§3).

### `select` — Direct

Already JS-only (`ownedBrowserAct.cjs:122-129`): set `sel.value`, dispatch
`change`. This is *fortunate*, because WebKit renders `<select>` menus natively
and no amount of event synthesis opens one. The current implementation is
already the only strategy that works on WKWebView.

### `scroll` — Direct

`window.scrollBy` / `buildScrollElementJs` (`ownedBrowserAct.cjs:550`) are JS
and port as-is; more reliable than event synthesis. On iOS
`webView.scrollView.contentOffset` is also available; on macOS there is no
exposed scroll view, so JS remains the path — matching today's implementation.

> Carry-over note, not a port issue: `scroll` is the one mutating action that
> does **not** invalidate the snapshot (`controller.cjs:279`), while every other
> one does. Worth confirming intent during the port, since cached
> `clientX/clientY` fallbacks go stale after scrolling.

### `go_back` / `go_forward` — Direct

`webContents.navigationHistory.canGoBack()/goBack()`
(`ownedBrowserAct.cjs:1766-1793`) → `WKWebView.canGoBack/goBack`,
`backForwardList`.

### `press_key` — Workaround / macOS-only

Today `sendRealKey` (`ownedBrowserAct.cjs:180-196`) emits trusted
`keyDown`/`char`/`keyUp`. Under WKWebView, synthesized `KeyboardEvent`s reach
page listeners (fine for app-level shortcuts a page implements in JS) but do
**not** reach anything the engine handles natively. Trusted keys need macOS
`NSEvent.keyEvent(with:)` routed through `window.sendEvent(_:)` with correct
`characters`, `charactersIgnoringModifiers`, `keyCode`, `modifierFlags`.

The unexposed-but-present verbs `select_all` / `copy` / `cut` / `paste`
(`ownedBrowserAct.cjs:1985`, `:1993`) map to `NSResponder` actions
(`selectAll:`, `copy:`) sent to the WKWebView on macOS; on iOS,
`UIResponderStandardEditActions`. Both require the web view to be first
responder with a live selection, so they are less dependable than
`webContents.copy()`.

### `extract` — Direct

`executeJavaScript` reading `el.value ?? el.innerText` capped at 2000 chars
(`controller.cjs:381`). Ports to `callAsyncJavaScript`, which is strictly
better — native argument marshalling, no string interpolation.

### `wait` — Direct

Host-side `setTimeout`; no browser API involved.

### `screenshot` — Workaround

| | |
|---|---|
| Today | `webContents.capturePage()` → `NativeImage.resize/toJPEG/toDataURL` (`ownedBrowserAct.cjs:2303-2336`), max width 1200, JPEG q70, metadata recorded |
| WKWebView | `takeSnapshot(with:)` + `WKSnapshotConfiguration`. Use **`snapshotWidth`** (iOS 13/macOS 10.15) to set the vision budget in points rather than resizing afterward — cheaper than the current resize step |

Three caveats that change design:

- **`rect` larger than the viewport returns blank or clipped content.** WebKit
  only has tiles for what's rendered. Do not build full-page capture on
  `takeSnapshot`.
- **Full-page capture** → `createPDF(configuration:)` (iOS 14/macOS 11) with
  `rect` = full `scrollWidth`/`scrollHeight`, rasterized via `CGPDFDocument`;
  or scroll-and-stitch (most robust for lazy-loaded pages, but sticky headers
  must be hidden between shots).
- **Offscreen/occluded views produce blank snapshots.** WebKit throttles
  rendering outside a visible window. Set `afterScreenUpdates = false` when
  not visible (with `true` the completion handler can hang), and keep the view
  in a real window parked offscreen (e.g. `x: -20000`) rather than hidden or
  zero-sized. This is a behavioral difference from `capturePage`, which is
  more forgiving.

Budget ~30–120 ms per viewport snapshot (IPC round-trip + encode);
`createPDF` on a long page is hundreds of ms to seconds. `visionPolicy.cjs`'s
existing throttling matters more, not less.

### `open_tab` / `close_tab` / `switch_tab` — Direct (and a chance to fix)

These are **dead code today**: `agentRuntime.cjs:6162` constructs the
controller with `{webContents, actuator}` and no `tabs` adapter, so `open_tab`
silently degrades to same-tab navigation and the other two return
`single_tab_mode` (`controller.cjs:415-436`).

WKWebView's per-tab model is one `WKWebView` per tab — a clean fit for the
adapter interface `controller.cjs:20-23` already declares
(`list / open / close / activate / getActiveWebContents`). The port is the
natural moment to either wire this properly or drop the actions from the
schema; shipping them as no-ops wastes model attention either way.

### `ask_user` — Direct

No browser API. Raises the window and polls the live page via
`waitForUserAssist` (`ownedBrowserAct.cjs:9860`) — repeated `getPageContext` +
`waitForDomSettle`. All JS + host timers; ports unchanged. The handover model
(user acts in the same visible tab, agent resumes in place) is unaffected.

---

## 3. Observation layer

### Page catalog and text — Direct, with a frame-discovery gap

| Today | WKWebView |
|---|---|
| `webContents.executeJavaScript(COLLECT_INTERACTABLES_JS)` (`ownedBrowserAct.cjs:1427`) | `callAsyncJavaScript` in an isolated `WKContentWorld` |
| `mainFrame.framesInSubtree` (`:1584`), `fr.executeJavaScript` (`:1594`) | `evaluateJavaScript(_:in: WKFrameInfo, contentWorld:)` (iOS 14/macOS 11) — genuinely executes in a specific child iframe, including cross-origin |
| `buildFrameOffsets` via `parent.executeJavaScript(COLLECT_FRAME_RECTS_JS)` (`:1550`) | unchanged, pure JS |

**The gap: there is no public API to enumerate a page's frames.** No
`Page.getFrameTree`, no `framesInSubtree`. `WKFrameInfo` arrives only through
delegate callbacks, and the objects are snapshots, not stable identifiers —
a stale one errors the evaluation.

**Standard workaround, and the one to adopt:** inject a
`forMainFrameOnly: false`, `atDocumentStart` `WKUserScript` that immediately
`postMessage`s a handshake. Every frame — dynamic and cross-origin included —
self-registers; cache the resulting `WKFrameInfo` against a frame token minted
in the script. Re-handshake on every navigation.

This is *more* robust than today's `framesInSubtree` sweep for dynamically
inserted frames, and less robust for frames that block script execution.
Cross-frame reads (`collectFrameTexts` `:1648`) and the frame-routed
`replace_text`/`select`/`type` paths depend on it, so it is a prerequisite, not
a nicety.

### Isolated worlds — better than today

`WKContentWorld.page` / `.defaultClient` / `.world(name:)` give real isolated
worlds sharing the DOM but not globals. Capture references to `Object`,
`Array`, `JSON`, and `Element.prototype.getBoundingClientRect` at
document-start so page code cannot tamper with the serializer — a hardening
the current `executeJavaScript`-into-page-world approach cannot achieve.

`WKScriptMessageHandlerWithReply` (iOS 14/macOS 11) gives JS a real Promise
back, which is a cleaner RPC channel than anything Electron offers here.

### Accessibility tree — **do not build on it**

Tempting, and a dead end. The tree lives in the web content process and is
bridged by remote tokens, so in-process traversal returns an opaque element;
WebKit only *builds* the tree when an assistive client attaches, so cold reads
yield an empty `AXWebArea`; and forcing it via `AXUIElement*` against your own
process needs the Accessibility TCC grant anyway. On iOS there is effectively
nothing. **Keep building the page model from injected JS reading ARIA and
computed roles** — a superset of the a11y tree, deterministic, identical on
both platforms. This is what LYKN already does.

### Settle detection — Workaround

`waitForLoad` (`ownedBrowserAct.cjs:1316`) and `waitForDomSettle` (`:9925`,
double-`requestAnimationFrame`) mostly port. There is no equivalent of CDP's
`Page.lifecycleEvent` / network-idle: inject a `PerformanceObserver` +
`MutationObserver` plus patched `fetch`/`XMLHttpRequest` in an isolated world
and report quiescence over the message handler.

### Snapshot / ref lifecycle — unchanged

`buildSnapshot`, `diffSnapshots`, `formatSnapshotForModel` (`snapshot.cjs`) and
the `stale_reference` / `unknown_reference` contract (`controller.cjs:36-44`,
`verifier.cjs:53-57`) are pure JS over data the injected script produces. No
change.

---

## 4. Substrate: tabs, sessions, permissions, files

### Window and tab model

| Today (`main.cjs`) | WKWebView |
|---|---|
| `WebContentsView` per tab in `agentBrowserViews` (`:3508`), cap 20 (`:3518`) | one `WKWebView` per tab |
| `win.contentView.addChildView/removeChildView` (`:3976`/`:3983`), `view.setBounds` (`:4993`) | ordinary `NSView`/`UIView` hierarchy |
| `wc.setWindowOpenHandler` (`:4763`) — popups get a child `BrowserWindow` on the **same partition** so OAuth cookies carry | `WKUIDelegate.webView(_:createWebViewWith:for:windowFeatures:)` — return a new `WKWebView` built with the **passed-in configuration** (that's what carries the opener relationship; `window.opener` breaks otherwise), `nil` to block. Also implement `webViewDidClose(_:)` |
| — | `WKWebViewConfiguration` is **copied** on `WKWebView(frame:configuration:)`. Share the objects inside it (`websiteDataStore`, `userContentController`), never the configuration |
| — | Popup blocking interacts with user activation: `window.open` from a synthetic click may be suppressed. Set `preferences.javaScriptCanOpenWindowsAutomatically = true` — important for an agent |

### Profiles and cookies — Direct, and better

| Today | WKWebView |
|---|---|
| Shared `persist:lykn-agent-browser` partition (`main.cjs:3539`); per-tab ephemeral `lykn-agent-incognito-<id>` (`:3713`); incognito toggle **rebuilds the view** on the other partition (`:5174`) | `WKWebsiteDataStore(forIdentifier: UUID)` (**iOS 17/macOS 14**) gives real multi-profile persistent stores with independent cookies, localStorage, IndexedDB, caches. `.nonPersistent()` for incognito. `fetchAllDataStoreIdentifiers` / `remove(forIdentifier:)`. You persist the UUID yourself |
| — | `WKProcessPool` is **deprecated and vestigial** ("no longer has any effect", macOS 12/iOS 15). Don't design around it |
| — | `WKHTTPCookieStore` includes **HttpOnly cookies** in `getAllCookies` — a real capability gain, equivalent to CDP `Network.getAllCookies`. Caveat: cookies set before the first load in a fresh store can be dropped; load `about:blank` first, then set, then navigate |

**New risk with no Electron analogue: ITP.** WebKit's Intelligent Tracking
Prevention actively expires cookies and caps script-writable storage at 7 days
for domains without *user interaction*. An account the agent only ever visits
via automation can get silently logged out. There is no public off-switch
(`_resourceLoadStatisticsEnabled` is SPI). Plan for re-authentication as a
normal operating condition, not an error path.

### Client-hint spoofing — needs redesign

`wireAgentSessionClientHints` (`main.cjs:4845`) rewrites `Sec-CH-UA*` headers
via `sess.webRequest.onBeforeSendHeaders` so Google OAuth accepts the embedded
browser. **This is load-bearing for sign-in and has no WKWebView equivalent**
(see §5). Under WebKit the whole premise changes — you are Safari-shaped, and
`Sec-CH-UA` is a Chromium construct Safari doesn't send. Likely the problem
dissolves; verify early, because if it doesn't, there is no header-rewriting
tool to fall back on.

Related: **do not set `customUserAgent`** unless forced — hand-rolling the whole
string means hand-maintaining the OS and WebKit tokens WebKit already gets
right. Use `applicationNameForUserAgent`, and
`WKWebpagePreferences.preferredContentMode = .desktop` for desktop viewport/UA
on iPad.

**Corrected — see §11, bug 4.** The claim originally made here, that the default
WKWebView UA is "already Safari-shaped", is false, and the port shipped a
version-less UA on the strength of it. A default `WKWebView` stops after
`(KHTML, like Gecko)`: no `Version/x`, no `Safari/x`.
`applicationNameForUserAgent` is the slot Safari itself fills with those tokens,
so passing a bare app name through it replaces a browser identity that was never
there.

### Permissions

`sess.setPermissionRequestHandler` (`main.cjs:4815`, allowing only
`fullscreen`, `clipboard-sanitized-write`, `clipboard-read`) maps to:

- media → `WKUIDelegate.webView(_:requestMediaCapturePermissionFor:initiatedByFrame:type:decisionHandler:)`
  (iOS 15/macOS 12), auto-grantable; needs `NSCameraUsageDescription` /
  `NSMicrophoneUsageDescription` and, sandboxed, `com.apple.security.device.camera` / `.audio-input`
- JS dialogs → `runJavaScriptAlertPanelWithMessage:` / `Confirm` / `TextInputPanel`.
  **You must implement these**; the default is to do nothing, which hangs the page
- geolocation → **no delegate hook.** WebKit routes `navigator.geolocation`
  through CoreLocation using *your app's* authorization; the page-level prompt
  is WebKit's own and cannot be pre-approved. Spoofing requires overriding
  `navigator.geolocation` in an `atDocumentStart` page-world script

### File upload — **the CDP replacement problem**

CDP is used exactly once in the entire codebase: `attachFileToGmailCompose`
(`ownedBrowserAct.cjs:9441`) attaches the debugger and issues
`DOM.getDocument` → `DOM.querySelector` → `DOM.setFileInputFiles` (`:9462`,
`:9478`, `:9493`).

**macOS — a genuinely good replacement.**
`WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`
(macOS 10.12+, **macOS only**) hands you a completion handler taking `[URL]?`,
and **you may call it immediately with file URLs and never show a panel.** The
page receives real `File` objects with correct `name`/`size`/`type` and working
`FileReader`/`FormData`/streaming — functionally equivalent to
`DOM.setFileInputFiles`. Sandboxed apps should copy the file into the app
container first and pass that URL, sidestepping security-scoped bookmarks
entirely.

**The catch:** the panel only fires on a **user-activated** click of the file
input. A synthetic `el.click()` will not trigger it. So on macOS, file upload
specifically depends on the `NSEvent`/`CGEvent` route — this single feature
pulls trusted input onto the critical path.

**iOS — no equivalent.** There is no `runOpenPanelWith`; WebKit presents its
own picker with no delegate hook. The only path is JS `DataTransfer` injection:

```js
const dt = new DataTransfer();
dt.items.add(new File([bytes], name, { type: mime }));
input.files = dt.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
```

Ship the bytes in via `callAsyncJavaScript` arguments (base64 — costly for
large files) or serve them from a `WKURLSchemeHandler` custom scheme and
`fetch()` them in-page. Works for pages that read `input.files`/`FormData`;
fails for pages requiring a trusted `change` or user activation. This is also a
reasonable macOS fallback when trusted input is unavailable.

### Downloads — Direct, and better in one respect

| Today | WKWebView |
|---|---|
| `sess.on("will-download")` + `item.setSavePath` (`main.cjs:4869-4877`), `shell.showItemInFolder` (`:4881`) | `WKDownloadDelegate` (iOS 14.5/macOS 11.3): `download(_:decideDestinationUsing:suggestedFilename:)`, `downloadDidFinish:`, `didFailWithError:resumeData:`, KVO on `download.progress` |
| `wc.downloadURL(url)` (`main.cjs:11212`) | `WKWebView.startDownload(using:completionHandler:)` — fetches with **the webview's cookies and session**, which is cleaner than Electron's equivalent |
| `decidePolicyFor` → `.download` (iOS 14.5+) converts a navigation or response into a download | |

Destination URL must not already exist and its parent must be writable by the
sandbox; `com.apple.security.files.downloads.read-write` gets you `~/Downloads`.
The de-duplication logic in `main.cjs:4874` ports as-is.

Artifact serving via `ses.protocol.*` (`lykn-artifact://`, `main.cjs:5330`) →
`WKURLSchemeHandler` for custom schemes. Fine — the ban is on `http`/`https`
only.

---

## 5. The hard gaps

Ranked by how much they should influence the go/no-go.

**1. Trusted input.** No public WebKit API injects a trusted event into a
`WKWebView`. The machinery exists — `_WKAutomationSession`,
`isSimulatingUserInteraction`, `EventSenderProxy` in `WebKitTestRunner` — but
all of it is SPI or test-harness-only. macOS recovers most of it via
`NSEvent`/`CGEvent`; **iOS recovers none of it** (no `CGEvent`, no `UITouch`
synthesis; only XCUITest, which cannot ship in a normal app).

**2. Network interception.** Today LYKN uses
`sess.webRequest.onBeforeSendHeaders` for the load-bearing client-hint rewrite.
There is no `Fetch.enable` equivalent, and:
- `WKURLSchemeHandler` **cannot register `http`/`https`** — it throws at
  configuration time
- `NSURLProtocol` does not apply to WKWebView (its networking lives in the
  network process)
- `WKContentRuleList` (iOS 11/macOS 10.13) gives declarative
  `block` / `block-cookies` / `css-display-none` / `make-https` — blocking and
  scheme upgrades only, no header or body rewriting
- `WKWebExtension` + `declarativeNetRequest` (macOS 15.4/iOS 18.4) adds some
  redirect/header ops, still not arbitrary rewriting
- a local proxy needs a Network Extension entitlement — App Store restricted
- monkey-patching `fetch`/`XHR`/`WebSocket` at document-start covers only
  page-initiated traffic, missing subresources and navigations

Response *inspection* is likewise limited to main-resource status and headers
via `decidePolicyFor navigationResponse:`. No `Network.getResponseBody`.

**3. Canvas-drawn UIs** (Figma, Docs' canvas renderer, maps). No DOM to target,
so hit-testing must come from the vision model and actuation must be trusted
events — meaning **this whole class of site is macOS-only, and lost on iOS.**
Today these are exactly the sites that already need `click_coord` plus the
clipboard-paste typing path, both of which degrade.

**4. PDFs.** WKWebView renders them natively but they are not a DOM — no JS,
no injection, no text extraction. The agent goes blind. Workaround: detect
`application/pdf` in `decidePolicyFor navigationResponse:`, convert to
`.download`, process with PDFKit; or serve PDF.js from a custom scheme.

**5. Closed shadow roots.** Isolated worlds do *not* help — WebKit honors
closed-ness across worlds. The one workaround is an `atDocumentStart`
**page-world** script patching `Element.prototype.attachShadow` to force
`{mode: 'open'}` (or stash roots in a WeakMap) before any page code runs.
Open shadow roots are fine; remember `composed: true` on synthesized events and
that `document.elementFromPoint` returns the host — recurse with
`shadowRoot.elementFromPoint`.

**6. `Emulation.*`.** Device metrics, timezone, locale, CPU throttling — no
equivalents. Viewport = resize the view; `preferredContentMode` is the coarse
substitute.

**7. Web process termination.** `webViewWebContentProcessDidTerminate(_:)`
**will** fire in long-lived agentic sessions, leaving a blank view with all
injected state gone. Must be handled by recreating the view and
re-establishing worlds, user scripts, and frame handshakes. Electron's
equivalent (`render-process-gone`) is not currently wired in the actuation path
— this becomes newly mandatory.

---

## 6. What gets better

Not everything is a loss:

- **`callAsyncJavaScript`** with native argument marshalling removes the
  base64-JSON-into-string-template pattern used throughout
  `controller.cjs:420` and `ownedBrowserAct.cjs`'s script builders.
- **Real isolated worlds** let the injected runtime be tamper-proof against
  page JS — impossible today.
- **`WKScriptMessageHandlerWithReply`** gives a proper promise-based JS→native
  channel; the frame handshake it enables is more robust for dynamic frames
  than `framesInSubtree` polling.
- **`WKWebsiteDataStore(forIdentifier:)`** is a cleaner multi-profile model
  than Electron partitions, with first-class enumeration and deletion.
- **`startDownload(using:)`** fetches authenticated resources with the
  webview's session — currently awkward in Electron.
- **HttpOnly cookie access** via `WKHTTPCookieStore`.
- **No `navigator.webdriver` / CDP-detection surface.** WKWebView sets no
  automation flag, and WebKit exposes less fingerprinting entropy by design.
  This offsets — partially — the `isTrusted` signal.
- **`WKWebExtension`** (macOS 15.4/iOS 18.4) is a supported, maintained
  extension surface with content scripts and `declarativeNetRequest`, if agent
  capabilities can be expressed that way.

---

## 7. Prior art

- **safaridriver** drives Safari.app only; it cannot attach to a third-party
  app's `WKWebView`. Not usable.
- **WebKit's `_WKAutomationSession` SPI** is precisely the thing that makes
  WebDriver's trusted input work inside WebKit. Off-limits for App Store; a
  research spike at best for Developer ID, with breakage risk on every OS
  update.
- **`WKWebView.isInspectable`** (iOS 16.4/macOS 13.3) exposes the view to
  Safari's Web Inspector protocol — CDP-adjacent domains, reachable through
  the inspector daemon, not from your own process. Great for developing the
  injected JS layer; not a shipping actuation path.
  `ios-webkit-debug-proxy` bridges it to a CDP-ish socket for the same purpose.
- **Playwright's WebKit** builds a *patched* upstream WebKit and runs its own
  host app — irrelevant as a dependency. **Highly relevant as a reference:**
  its patches show exactly which SPI trusted input requires, and its
  `injectedScript` is a mature, battle-tested actionability / text-input /
  element-query implementation worth porting directly into the injected
  runtime. Highest-leverage borrow in this whole document.
- **`flutter_inappwebview`** is the most complete public WKWebView
  feature-mapping (inspectable, cookies, downloads); **Capacitor/Cordova**
  demonstrate the custom-scheme-proxy pattern that works around the
  `http`/`https` scheme-handler ban.

---

## 8. Recommended shape of the port

1. **Split the actuation layer behind a `Backend` protocol** with two
   implementations: `JSSyntheticBackend` (both platforms, the baseline) and
   `NativeEventBackend` (macOS only). **Every action must have a JS fallback
   or iOS is dead.** The current `controller.cjs` interface is already the
   right seam.
2. **Prefer `NSEvent` + `NSApp.postEvent` over `CGEventPost`.** It yields
   trusted events with zero TCC prompt, is sandbox-safe, and is App Store
   viable. Reserve `CGEvent` for where `NSEvent` desync (hover, drag) actually
   breaks things, behind an opt-in "advanced mode" that explains the
   Accessibility prompt.
3. **Assume Developer ID distribution on macOS** if trusted input turns out to
   be core. App Store review routinely rejects Accessibility-driven automation
   as a core function.
4. **Build the page model entirely from injected JS** in an isolated
   `WKContentWorld`, `atDocumentStart`, `forMainFrameOnly: false`, with a
   frame handshake over `WKScriptMessageHandlerWithReply`. Never the
   accessibility tree.
5. **Port Playwright's injected-script actionability and text-input logic**
   rather than reinventing the synthetic-event sequences.
6. **Reproduce `lastScreenshotMeta` exactly** against `takeSnapshot`, including
   `pageZoom`/`zoomScale`, before touching `click_coord` or `drag`.
7. **Handle `webViewWebContentProcessDidTerminate`** by rebuilding the view
   and all injected state.
8. **Decide the tab story now** — wire `agentBrowserViews`' equivalent into the
   `tabs` adapter, or drop `open_tab`/`close_tab`/`switch_tab` from the schema.
9. **Re-test Google sign-in first.** The `Sec-CH-UA` rewrite is load-bearing
   today and has no replacement; find out early whether being Safari-shaped
   makes it moot.

### Feasibility summary

| Surface | macOS | iOS |
|---|---|---|
| Navigation, scroll, extract, select, replace_text, snapshot/observe | Full | Full |
| Typing (plain fields, most rich editors) | Full | Full |
| Typing (IME/CJK, canvas editors) | Degraded | Degraded |
| Click (ordinary web UI) | Full | Workable, `isTrusted:false` |
| Click (user-activation-gated, native controls) | Full via `NSEvent` | **Lost** |
| Drag (HTML5 cooperative) | Full | Full |
| Drag (pointer-driven, sortables, canvas) | Full via `NSEvent`/`CGEvent` | **Lost** |
| File upload | Full via `runOpenPanelWith` (needs trusted click) | Partial via `DataTransfer` |
| Downloads, profiles, cookies, permissions | Full (some better) | Full |
| Header rewriting / network interception | **Lost** | **Lost** |
| Canvas-app operation (Figma, Docs canvas) | Workable via vision + trusted input | **Lost** |
| Bot-detection posture | Mixed: no webdriver signal, but `isTrusted` leaks | Worse |

**Bottom line:** a macOS WKWebView port is feasible and costs the network-
interception layer plus ongoing IME and drag fidelity. An iOS port cannot
operate user-activation-gated flows or canvas applications at all, and should
be scoped as a materially narrower agent — read-heavy research and ordinary
form-filling — rather than a port of the same capability set.

---

## 9. Implementation status

Built as a Swift package at `native/LYKNAgent/`, macOS 14+, three targets:

| Target | What it is | Replaces |
|---|---|---|
| `LYKNAgentCore` | The brain. Planner, executor, verifier, task state, memory, vision policy, recovery, context router, instruction resources, the run loop, and the `BrowserController` protocol. | `electron/browser-agent/**` |
| `LYKNWebKit` | The browser. Injected runtime, actuation backends, tabs, profiles, downloads, uploads, snapshot capture, and the controller implementation. | `browser/controller.cjs` + `ownedBrowserAct.cjs` |
| `LYKNAgentApp` | SwiftUI shell: browser stage, tab strip, agent sidebar, approval and handover cards. | `electron/main.cjs` agent-browser plumbing |

The seam held. `BrowserController.swift` is a line-for-line port of the
interface `controller.cjs` declared, and nothing above it knows which browser
it is driving — which is what made the rest of the port mechanical.

### §8's recommendations, and what happened to each

| # | Recommendation | Where it landed |
|---|---|---|
| 1 | Split actuation behind a `Backend` protocol, JS fallback for every action | `ActuationBackend.swift`, `JSSyntheticBackend.swift`, `NativeEventBackend.swift`. The native backend falls back to JS whenever the view has no window. |
| 2 | Prefer `NSEvent` + `NSApp.postEvent` over `CGEventPost` | `NativeEventBackend` posts `NSEvent`s by default; `CGEvent` is behind `advancedMode`, off unless explicitly enabled. |
| 3 | Assume Developer ID if trusted input is core | Not a code decision — still open, and file upload does put trusted input on the critical path. |
| 4 | Page model from injected JS in an isolated world, frame handshake over a message handler | `lykn-runtime.js` + `InjectedRuntime.swift` + `FrameRegistry.swift`. `atDocumentStart`, `forMainFrameOnly: false`, isolated `WKContentWorld`. |
| 5 | Port Playwright's injected-script actionability rather than reinventing it | **Not done — and §8.5 overstates what there is to borrow.** See "Correcting §8.5" below. |
| 6 | Reproduce `lastScreenshotMeta` exactly, including zoom | `CoordinateMapper.swift` + `SnapshotCapture.swift`, with `pageZoom` as the added term. 12 tests cover the mapping and the label-snap. |
| 7 | Handle `webViewWebContentProcessDidTerminate` | `BrowserTab.rebuildAfterTermination()` — rebuilds the view, resets the frame registry, discards stale screenshot metadata, reloads. |
| 8 | Decide the tab story | Wired, not dropped. `TabManager` gives the controller a real `tabs` adapter, so `open_tab` / `close_tab` / `switch_tab` stop being no-ops. |
| 9 | Re-test Google sign-in first | **Not done** — needs live testing. See below. |

### Correcting §8.5

§8.5 says to port Playwright's injected-script logic "rather than reinventing
the synthetic-event sequences," and §7 calls it "the highest-leverage borrow in
this whole document." Both overstate it, because Playwright's automation splits
across three layers and only one of them lives in the injected script:

| Layer | Where it lives in Playwright | Portable here? |
|---|---|---|
| Actionability predicates — visible, stable, enabled, receives events | Injected script, evaluated in one synchronous in-page call | **Yes** |
| Retry / auto-wait loop | Driver side, retried until the predicates pass or the timeout expires | No — would have to be written in Swift |
| Input dispatch | `Input.dispatchMouseEvent` over CDP — real trusted events | **No** |

So **Playwright has no synthetic-event sequences to borrow.** It never needed
them: it has trusted input through the debug protocol, which is precisely the
capability WKWebView withholds and the reason this document exists. The
pointer/mouse pairing and the typing ladder in `lykn-runtime.js` are not a
reinvention of Playwright's work — they solve a problem Playwright was never in
a position to have, and `NativeEventBackend` is this port's answer to the same
gap on macOS.

What is genuinely portable is narrower: the actionability predicates and
`fill()`'s value-setting. Of those the runtime already has visibility
(`visible`/`clickable`) and pre-click hit-testing (`hitTest`/`topmostAt`,
including descent through shadow roots). The two real gaps are:

- **No stability check.** Nothing waits for an element's bounding box to hold
  still across consecutive animation frames, so an action can land in the
  middle of a transition — and the synthetic backend bypasses the compositor,
  so it cannot even fail loudly.
- **No hit-target interception.** `hitTest` checks before the fact only; there
  is no post-hoc verification that the click landed on the intended element.
  §11's bug 2 is exactly the failure that check exists to catch.

There is also no retry anywhere: actions are one-shot, and `typeInto` reports
`verified: false` rather than waiting for an element that is not ready yet.

Playwright is Apache-2.0 ("Portions Copyright (c) Microsoft Corporation.
Portions Copyright 2017 Google Inc."), so the borrow is legally clean with
attribution and a NOTICE entry. Still worth doing — the stability check and
hit-target interception are real missing coverage — but it is a contained job
against two predicates, not the sweeping borrow §7 and §8.5 describe, and it
does not reduce the risk in the event synthesis, which is where the untested
surface actually is.

### What is genuinely better now

- **Tamper-proof observation.** The runtime captures `Object`, `JSON`,
  `getBoundingClientRect`, `elementFromPoint` and friends at document start, in
  an isolated world. Page code cannot corrupt the agent's view of the page — an
  Electron `executeJavaScript` build could not do this.
- **`callAsyncJavaScript` argument marshalling** removed the
  base64-JSON-into-a-string-template pattern entirely. No payload is escaped
  into source text any more.
- **The frame handshake beats `framesInSubtree`** for dynamically inserted
  frames, which register themselves the moment they exist.
- **Real multi-profile stores** via `WKWebsiteDataStore(forIdentifier:)`, with
  enumeration and deletion.
- **Tabs actually work**, for the first time.
- **Element labels are normalized.** `labelOf` collapses runs of whitespace;
  the Electron collector only trims. This matters because
  `formatSnapshotForModel` renders one `[eN] role "label"` per line, and an
  unnormalized label containing newlines splits an element across several
  lines. See the parity capture below.

### Parity with the Electron stack, measured

Both stacks were driven over the same URLs and their rendered snapshots
compared: Electron 42 through the real `ownedBrowserAct` actuator and
`createBrowserController`, WKWebView through the real `WebKitBrowserController`.

- **example.com — byte-identical output** from both, `PAGE` header through
  `VISIBLE CONTENT`.
- **duckduckgo.com — both saturated the 170-item collector cap** (so the count
  itself is not evidence), but the refs matched one-for-one in the same order
  and the first raw item was identical field-for-field.
- **The action schema is identical**: the same 17 `ActionType` cases and the
  same output-contract prose, string for string, on both sides.

Three differences, none of them a port defect:

1. **Label whitespace**, as above — Chromium emits multi-line labels such as
   `li "Make DuckDuckGo your default search engine.\nSet As Default Search"`;
   the WKWebView runtime renders the same element on one line.
2. **Catalog fields.** WKWebView items carry `frameId` / `frameUrl` /
   `frameHost` / `frameOffsetKnown` on every item, since WebKit has no stable
   frame identifier and the runtime mints its own token. Electron used
   `routingId` and tagged only cross-frame items.
3. **The page itself differs by user agent.** DuckDuckGo serves `[e15]` as a
   `link` to Chromium and a `button` to WebKit. Not a divergence in the port.

This is the strongest available evidence for the "the seam held" claim above:
everything upstream of `BrowserController` sees the same page model from either
browser.

### What degraded, precisely

- **Network interception is gone.** No `onBeforeSendHeaders` equivalent exists,
  so `wireAgentSessionClientHints` has no replacement. The premise probably
  dissolves — `Sec-CH-UA` is a Chromium construct Safari does not send, and the
  port sets no `customUserAgent` — but this is unverified and is the single
  most likely thing to break Google sign-in. Note that the "we are Safari-shaped
  anyway" half of that argument only became true with §11 bug 4's fix; it was
  false for the whole period this section describes.
- **IME / composition is unimplemented, not merely degraded.** The typing
  ladder does not fabricate `compositionstart`/`update`/`end`, so CJK and emoji
  input has no path at all. `NSEvent` synthesis skips `interpretKeyEvents:`, so
  the trusted backend does not rescue it either.
- **Google Docs / Sheets special-casing was not ported.** The Electron actuator
  injected a synthetic `docs_editor_body` target and prefixed the page scrape
  with a "this is canvas-rendered, do not conclude it is blank" note. Neither
  exists here, so canvas-editor runs lose that scaffolding and lean entirely on
  the vision path.
- **Clipboard-paste typing is gone.** Long text on Docs used
  `clipboard.writeText` + `webContents.paste()`; clipboard write is itself
  user-activation-gated, so canvas-backed editors fall back to the ladder's
  per-character path plus vision.
- **Full-page capture is a stub.** `SnapshotCapture.capturePDF` returns PDF
  data but nothing rasterizes or stitches it. Viewport capture plus `scroll` is
  the working path.
- **Untrusted clicks when the window is absent.** The JS backend is honest about
  `isTrusted: false` and reports `unverified` for key presses it cannot land,
  but everything gated on transient user activation still fails there.

### Not ported, deliberately

`ownedBrowserAct.cjs` is ~11.9k lines, of which roughly the first 2.4k are the
actuator the modular agent uses. The remainder — `executeOwnedAdaptiveTask`,
the browse-goal phase heuristics, brand/URL resolution, the share-dialog
special cases — belongs to the older non-modular loop and is not reachable
through `controller.cjs`. None of it was ported.

### Open before this can ship

0. **Fix the `settle()` deadlock** (§11, bug 3). It is listed first because it
   is a live defect rather than unfinished work, and because it can hang a run
   indefinitely on any slow-loading page.
1. **Run it against real sites.** Nothing below the unit tests has met a real
   page. Google sign-in first, per §8.9.
2. **Decide distribution.** File upload depends on `runOpenPanelWith`, which
   only fires on a user-activated click, which requires the `NSEvent` backend.
   That is App Store viable; `CGEvent` is not.
3. **App packaging.** This is an SPM executable, not a signed `.app` — no
   bundle, entitlements (`com.apple.security.files.downloads.read-write`,
   network client), hardened runtime or notarization yet.
4. **Wire real authentication.** `AgentSession.ModelConfiguration` reads
   `LYKN_API_BASE` / `LYKN_AGENT_TOKEN` from the environment; it needs the
   desktop-auth handoff the Electron shell already implements.
5. **ITP re-authentication.** WebKit expires cookies for domains without user
   interaction after 7 days, with no public off-switch. The agent's `ask_user`
   handover already covers it behaviorally, but it should be expected rather
   than treated as a fault.

---

## 10. Privacy posture and performance

Added after §9, once the port was building. Both are in
`native/LYKNAgent/Sources/LYKNWebKit/PrivacyConfiguration.swift`; the benchmark
is `native/bench/` with full method and raw samples in its README.

### What is enforced

| Control | Mechanism | Notes |
|---|---|---|
| HTTPS upgrade | `upgradeKnownHostsToHTTPS` (macOS 11.3+) plus `preferredHTTPSNavigationPolicy = .automaticFallbackToHTTP` (15.2+) | `.automaticFallbackToHTTP` rather than `.errorOnFailure`: an HTTP-only host must stay reachable or the upgrade becomes an outage |
| Tracker blocking | `WKContentRuleList`, one `block` rule per tracker host, all scoped `load-type: third-party` | ~50 high-confidence analytics/ad endpoints. Production should swap in a maintained list (Tracker Radar, EasyPrivacy); only the domain array changes |
| Third-party cookies | **WebKit's own default**, verified rather than set | Full third-party cookie blocking has been the default since Safari 13.1 and the knob is SPI — there is no setter to call |

Three implementation notes worth keeping:

**A `make-https` content rule is deliberately not used.** It upgrades
universally, but it has no fallback — a host without TLS simply becomes
unreachable. The two WebKit-managed mechanisms above handle failure properly.

**One rule per host, not one alternation over all of them.** WebKit's
content-rule regex dialect rejects a 50-way alternation outright (*"Invalid or
unsupported regular expression"*) while the same rules expressed individually
compile fine. `PrivacyPostureTests` compiles the real list on every test run,
because a rule list that silently fails to compile degrades to an ordinary
browser with no visible signal.

**There is deliberately no blanket third-party `block-cookies` rule.** It would
be stricter than WebKit's default in the one way that matters: content rules
have no Storage Access escape hatch, so a blanket rule breaks federated
sign-in — which is exactly the Google sign-in path §8.9 already flags as
load-bearing.

### Performance against the Electron build

Non-agentic page loads, steady state, 30 samples per cell, medians. Full table
and caveats in `native/bench/README.md`.

| metric | Chromium (Electron 42) | WKWebView | |
|---|---:|---:|---|
| TTFB | 4.2 ms | 1.0 ms | −76% |
| First contentful paint | 52.0 ms | 13.0 ms | −75% |
| DOMContentLoaded | 20.7 ms | 6.0 ms | −71% |
| Load event | 24.0 ms | 6.0 ms | −75% |
| Cold start | 984 ms | 734 ms | −25% |

WKWebView is faster on every page and every metric, with `js-heavy` the
narrowest margin (−41% on load) — that page is mostly JavaScriptCore versus V8,
and V8 is not far behind.

Costs measured rather than assumed: the injected agent runtime adds under 2ms
to a page load except on a 2500-node DOM, where document-start capture of
native references costs ~5ms. HTTPS upgrade and tracker blocking together are
within noise on tracker-free pages.

**Two things the headline hides**, both recorded in the benchmark README:
Chromium's large-DOM performance is *bimodal* — a ~38ms fast path that beats
WKWebView's ~47ms, and a ~190ms slow path it hits about a third of the time —
so on that page the truthful claim is consistency rather than speed. And the
tracker-blocking benefit is invisible locally, because synthetic pages have no
trackers; on live sites it removes ~11% of requests (cnn.com 92→83, bbc.com
76→67).

---

## 11. Actuation against live sites

`swift run LYKNActuate` (source: `native/LYKNAgent/Sources/LYKNActuate/`) drives
the real `WebKitBrowserController` through a scripted sequence on sites that
need no login. No model is involved — every decision is hard-coded — so a
failure is an actuation failure and nothing else.

| Scenario | Covers | Result |
|---|---|---|
| example.com | catalog, page text, title, `extract` | 6/6 |
| en.wikipedia.org | catalog on a 170-element page, `click` via trusted `NSEvent` | 3/3 |
| duckduckgo.com | typing ladder into a live search box, `press_key` Enter, submission | 3/3 |
| local `/form` | `type` (replace), `select`, `replace_text`, checkbox `click`, submit | 8/8 |
| news.ycombinator.com | `screenshot`, `scroll`, `click_coord` through the full 0–1000 chain | 5/5 |
| local `/fixture` | all 17 injected-runtime entry points, disabled/scrollable flags | 3/3 |
| staleness | `stale_reference`, `unknown_reference` | 2/2 |

**30/30.** Trusted input works: clicks report `via=nsevent`, and the Wikipedia
click landed on `/wiki/Talk:Web_browser` — the exact link aimed at. Typing
reports `verified=true` off a live read-back. The local form round-trips every
value: `?name=Ada+Lovelace&colour=green&notes=second+line&agree=on`.

### Two bugs this found, both invisible to unit tests

**1. Every catalog was empty.** The injected runtime captures native
references at document start so a page cannot tamper with them, and it captured
`window.getComputedStyle` *unbound*. Called with `this` bound to the capture
object rather than the window, WebKit throws `Can only call
Window.getComputedStyle on instances of Window`. Every `collectInteractables`
and `extractPageContext` call threw, the bridge swallowed it as "best effort",
and the agent saw a blank page everywhere. The existing test asserted the
script *contained* each entry point, which it did.

**2. Every trusted click landed in the wrong place.** `WKWebView.isFlipped` is
`true` on macOS, so its coordinate space already runs top-down like CSS.
`NativeEventBackend` flipped anyway, and `convert(_:to:)` flipped again — so a
click meant for y=114 was delivered at y=786.

The second is the more instructive failure, because the first version of the
harness *passed* with it. The assertions were "the URL changed" and "the click
returned ok", and on a dense page a mis-aimed click still hits something: it
upvoted the wrong Hacker News story and opened the wrong Wikipedia article,
both while reporting success. Only asserting **which** element was hit — the
landed path equals the targeted link's href, the voted id equals the targeted
arrow's id — exposed it.

Both are now guarded: `NativeEventGeometryTests` asserts `isFlipped` and that
`convert(_:to:)` already performs the flip, and the runtime entry-point
scenario executes all 17 functions rather than grepping for them.

### A third bug, found later and still open

**3. `settle()` never returns whenever its timeout path is taken.**

`BrowserTab.waitForLoad` (`BrowserTab.swift:129`) races a parked continuation
against a timeout inside `withTaskGroup`, then calls `resumeLoadWaiters()`
*after* the group closes. But `withTaskGroup` implicitly awaits every child
before it returns, and the parked child is only ever resumed by that call — so
when the timeout wins, the group cannot drain and the function never returns.
`group.cancelAll()` does not rescue it: `withCheckedContinuation` is not
cancellation-aware, so cancelling the child does not resume it.

The `timeoutMs` argument is therefore inert. Any page that has not fired
`didFinish` / `didFail` / `didFailProvisionalNavigation` inside the budget hangs
the agent permanently, and `settle()` is called on every navigation.

Reproduced two ways: in isolation, where a faithful copy of the structure with a
1-second timeout was still blocked at 8 seconds; and live, where
`settle(timeoutMs: 4000)` on duckduckgo.com never returned and a 240-second
watchdog had to kill the process. It was found while driving the controller to
capture snapshots for the parity comparison in §9 — not by this harness.

**Why the table above is still green.** DuckDuckGo passes here because on that
run the load completed inside the budget; the deadlock only fires when the
timeout wins. Every site in the table finishes loading, so the table exercises
only the path that returns. That is the same shape as bug 2 — a scenario that
passes because the bad path did not happen to be taken — and it is the second
time that shape has hidden a defect in this port.

**Fix, not yet applied:** resume the waiters from inside the group body, or drop
the group entirely for a single continuation resumed by whichever of the
delegate callback and a timer arrives first. Either way the regression test has
to assert that `waitForLoad` *returns* on a load that never completes, which
means a scenario built around a deliberately stalling page.

### A fourth bug, found from the parity work and fixed

**4. The port identified itself as a browser with no name and no version.**

`TabManager.makeConfiguration` set `applicationNameForUserAgent = "LYKN"`, on the
§4 reasoning that the default UA was already Safari-shaped and only needed an app
name appended. Both halves are wrong. Measured on this machine:

| configuration | resulting user agent | Docs |
|---|---|---|
| plain `WKWebView` | `…(KHTML, like Gecko)` | banner |
| as shipped | `…(KHTML, like Gecko) LYKN` | banner |
| `Version/26.0 Safari/605.1.15` | `…(KHTML, like Gecko) Version/26.0 Safari/605.1.15` | clean |

A bare WKWebView emits neither token, so there was no Safari identity for `"LYKN"`
to append to — it filled the slot instead. Google Docs reads the result as an
unknown browser and serves a reduced build behind a "This browser version is no
longer supported" banner.

The cost is not the banner. Re-capturing the same public document through the
real controller, the agent's catalog went from **21 elements to 28** once the
tokens were restored: the two banner controls (`Learn More`, `Dismiss`) go away,
and the live-presence layer — other viewers, sharing affordances — only appears
in the second case. The agent was working a deliberately degraded page and
nothing in the stack said so.

This is the same shape as bugs 2 and 3: every request succeeded, every test
passed, and the defect lived in what the page *was* rather than in any failure.

**Fixed.** `SafariUserAgent` (`SafariUserAgent.swift`) derives the version from the
installed Safari's `Info.plist`, falling back to a macOS-major map for sandboxed
builds that cannot read another bundle — Safari majors only realigned with macOS
at 26, so 14 and 15 are pinned. `TabManager` and `LYKNBench` both pass
`SafariUserAgent.applicationName`; nothing is appended after the Safari tokens,
because a unique app token is a fingerprint and the browser identity is what
version-gating sites read.

**Regression test.** `LYKNActuate`'s first scenario asserts the live
`navigator.userAgent` carries `Version/` and `Safari/605.1.15`, and — with
`hasSuffix`, not `contains` — that nothing trails them, so re-adding an app token
fails the suite rather than shipping quietly.

### Why the runtime coverage lives in the harness, not `swift test`

WKWebView's web content process does not come up in SPM's headless xctest host:
`callAsyncJavaScript` never returns and never throws, so a test that awaits it
hangs the suite rather than failing it. Anything requiring a live web view runs
under `LYKNActuate`'s real `NSApplication` instead. `swift test` stays fast and
hang-free (112 tests, ~0.2s); `LYKNActuate` is the integration gate.
