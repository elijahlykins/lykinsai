import AppKit
import Foundation
import LYKNAgentCore
import WebKit

/// `BrowserController` over WKWebView.
///
/// This type and `lykn-runtime.js` are the entire replacement for
/// `browser/controller.cjs` + `ownedBrowserAct.cjs`. Everything above the
/// protocol — planner, executor, verifier, task state, memory, vision policy —
/// is untouched by the port.
///
/// The strict-target semantics are preserved exactly: a covered target means a
/// dialog or menu is in the way, and an unresolvable one means the page changed
/// since the snapshot. Both need a re-observe, not a blind click, so they
/// surface as `element_obscured` / `element_not_relocated` rather than a guess.
@MainActor
public final class WebKitBrowserController: BrowserController {
    private let tabs: TabManager
    private var backend: ActuationBackend

    private var currentSnapshot: PageSnapshot?
    private var snapshotStale = true

    /// Total interactables allowed from sub-frames, on top of the main frame's.
    private static let maxFrameCatalogItems = 90

    public init(tabs: TabManager, backend: ActuationBackend) {
        self.tabs = tabs
        self.backend = backend
    }

    public func setBackend(_ backend: ActuationBackend) {
        self.backend = backend
    }

    public var activeBackendName: String { backend.name }

    private func activeTab() throws -> BrowserTab {
        guard let tab = tabs.activeTab else { throw BrowserGoneError() }
        return tab
    }

    // MARK: - Snapshot lifecycle

    public func invalidate() { snapshotStale = true }

    public func getCurrentSnapshot() -> PageSnapshot? {
        snapshotStale ? nil : currentSnapshot
    }

    /// The staleness contract the verifier and recovery ladder key off by
    /// name — `stale_reference` and `unknown_reference` both route to a
    /// re-observe rather than a retry.
    private enum RefError: String, Error {
        case missingTarget = "missing_target"
        case staleReference = "stale_reference"
        case unknownReference = "unknown_reference"
    }

    private func resolveRef(_ ref: String) -> Result<SnapshotElement, RefError> {
        let wanted = ref.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return .failure(.missingTarget) }
        guard let snapshot = currentSnapshot, !snapshotStale else {
            return .failure(.staleReference)
        }
        guard let element = snapshot.byRef[wanted] else { return .failure(.unknownReference) }
        return .success(element)
    }

    public func settle(timeoutMs: Int) async {
        guard let tab = try? activeTab() else { return }
        await tab.waitForLoad(timeout: .milliseconds(timeoutMs))
        await tab.waitForDOMSettle(budgetMs: min(timeoutMs, 3500))
    }

    // MARK: - Observation

    /// Capture a fresh structured snapshot. This is the ONLY way the agent sees
    /// the page; element refs are minted here and die on the next navigation.
    public func getPageState() async throws -> PageSnapshot {
        let tab = try activeTab()
        tab.frames.pruneStale()

        async let catalogTask = collectCatalog(tab: tab)
        async let contextTask = collectPageText(tab: tab)
        let (catalog, context) = await (catalogTask, contextTask)

        let snapshot = SnapshotBuilder.buildSnapshot(
            url: context.url.isEmpty ? tab.url : context.url,
            title: context.title.isEmpty ? tab.title : context.title,
            catalog: catalog,
            text: context.text,
            tabs: tabs.tabInfos()
        )
        currentSnapshot = snapshot
        snapshotStale = false
        return snapshot
    }

    private struct CatalogPayload: Decodable {
        var url: String = ""
        var title: String = ""
        var items: [CatalogItem] = []
        var frameToken: String = ""
    }

    private struct PageText {
        var url = ""
        var title = ""
        var text = ""
    }

    private struct FrameRect: Decodable {
        var src: String = ""
        var name: String = ""
        var x: Double = 0
        var y: Double = 0
        var w: Double = 0
        var h: Double = 0
    }

    private func collectCatalog(tab: BrowserTab) async -> [CatalogItem] {
        guard
            let main = await tab.bridge.decoded(
                CatalogPayload.self, "return __lykn.collectInteractables();"
            )
        else { return [] }

        var items = main.items
        // Embedded editors (campaign builders, code and rich-text widgets) live
        // in iframes. Without these the model can read the content but has no
        // handle to click or type into it.
        await measureFrameOffsets(tab: tab)
        items.append(contentsOf: await collectFrameInteractables(tab: tab))
        return items
    }

    /// Resolve every frame's offset relative to the top-level viewport.
    ///
    /// A frame cannot know where it sits (cross-origin blocks walking up to
    /// `window.parent`), but its parent can measure the `<iframe>` element. Each
    /// frame reports the rects of its own children; we then walk outward from
    /// the main frame, matching rects to frames by URL and accumulating
    /// ancestors' offsets — which is what makes coordinate clicks land inside
    /// embedded editors.
    ///
    /// Frames whose rect cannot be matched keep a nil offset, and their actions
    /// run inside the frame rather than by coordinate.
    private func measureFrameOffsets(tab: BrowserTab) async {
        let registry = tab.frames
        guard !registry.subFrames.isEmpty else { return }

        // Rects each frame measured for its own children.
        var rectsByToken: [String: [FrameRect]] = [:]
        for entry in registry.all {
            let frame: WKFrameInfo? = entry.isMain ? nil : entry.frame
            let rects = await tab.bridge.decoded(
                [FrameRect].self, "return __lykn.collectFrameRects();", in: frame
            )
            rectsByToken[entry.token] = rects ?? []
        }

        for entry in registry.subFrames { registry.setOffset(nil, for: entry.token) }

        var claimed = Set<String>()
        var queue: [String] = registry.mainToken.map { [$0] } ?? []
        var guardCounter = 0

        while let token = queue.first, guardCounter < 64 {
            queue.removeFirst()
            guardCounter += 1
            guard let parent = registry.entry(for: token),
                let parentOffset = parent.offset
            else { continue }

            var rects = rectsByToken[token] ?? []
            var unmatchedChildren: [FrameRegistry.Entry] = []

            for child in registry.subFrames where !claimed.contains(child.token) {
                guard let index = matchRect(rects, to: child.url) else {
                    unmatchedChildren.append(child)
                    continue
                }
                let rect = rects[index]
                rects.remove(at: index)
                registry.setOffset(
                    FrameRegistry.FrameOffset(
                        x: parentOffset.x + rect.x,
                        y: parentOffset.y + rect.y,
                        width: rect.w,
                        height: rect.h,
                        depth: parentOffset.depth + 1
                    ),
                    for: child.token
                )
                claimed.insert(child.token)
                queue.append(child.token)
            }

            // Exactly one unclaimed child and one leftover rect is
            // unambiguous even without a URL match — src can differ from a
            // frame's live URL after in-frame navigation.
            if rects.count == 1, unmatchedChildren.count == 1,
                let only = unmatchedChildren.first, !claimed.contains(only.token) {
                let rect = rects[0]
                registry.setOffset(
                    FrameRegistry.FrameOffset(
                        x: parentOffset.x + rect.x,
                        y: parentOffset.y + rect.y,
                        width: rect.w,
                        height: rect.h,
                        depth: parentOffset.depth + 1
                    ),
                    for: only.token
                )
                claimed.insert(only.token)
                queue.append(only.token)
            }
        }
    }

    /// URL match first, then origin+path prefix — `src` can differ from a
    /// frame's live URL after in-frame navigation.
    private func matchRect(_ rects: [FrameRect], to frameURL: String) -> Int? {
        guard !frameURL.isEmpty else { return nil }
        if let exact = rects.firstIndex(where: { !$0.src.isEmpty && $0.src == frameURL }) {
            return exact
        }
        let base = frameURL.split(separator: "?").first.map(String.init)?
            .split(separator: "#").first.map(String.init) ?? frameURL
        return rects.firstIndex { rect in
            guard !rect.src.isEmpty else { return false }
            let rectBase = rect.src.split(separator: "?").first.map(String.init)?
                .split(separator: "#").first.map(String.init) ?? rect.src
            return rectBase == base
        }
    }

    private func collectFrameInteractables(tab: BrowserTab) async -> [CatalogItem] {
        var out: [CatalogItem] = []
        var budget = Self.maxFrameCatalogItems
        let viewportWidth = Double(tab.webView.bounds.width)
        let viewportHeight = Double(tab.webView.bounds.height)

        for entry in tab.frames.subFrames {
            if budget <= 0 { break }
            guard
                let payload = await tab.bridge.decoded(
                    CatalogPayload.self, "return __lykn.collectInteractables();", in: entry.frame
                ), !payload.items.isEmpty
            else { continue }

            let offset = tab.frames.offset(for: entry.token)
            // A frame scrolled out of the top-level viewport has nothing in
            // view, however "in view" its own contents look from inside.
            let frameOnScreen: Bool
            if let offset {
                frameOnScreen =
                    offset.x < viewportWidth && offset.y < viewportHeight
                    && offset.x + (offset.width > 0 ? offset.width : viewportWidth) > 0
                    && offset.y + (offset.height > 0 ? offset.height : viewportHeight) > 0
            } else {
                frameOnScreen = true
            }
            let host = URLComponents(string: entry.url)?.host?
                .replacingOccurrences(of: "^www\\.", with: "", options: .regularExpression) ?? ""

            for var item in payload.items.prefix(budget) {
                item.id = "\(entry.token)_\(item.id)"
                item.frameId = entry.token
                item.frameUrl = entry.url
                item.frameHost = host
                item.frameOffsetKnown = offset != nil
                if let offset {
                    item.clientX += offset.x
                    item.clientY += offset.y
                }
                item.inView = frameOnScreen && item.inView
                out.append(item)
            }
            budget -= min(payload.items.count, budget)
        }
        return out
    }

    private func collectPageText(tab: BrowserTab) async -> PageText {
        struct ContextPayload: Decodable {
            var url: String = ""
            var title: String = ""
            var text: String = ""
        }
        guard
            let main = await tab.bridge.decoded(
                ContextPayload.self, "return __lykn.extractPageContext();"
            )
        else { return PageText(url: tab.url, title: tab.title, text: "") }

        var text = main.text
        // The top document may be mostly chrome (nav/shell) with the real
        // content in iframes — merge their text in unless the page is rich.
        if text.count < 12000 {
            var budget = 14000
            var extra: [String] = []
            for entry in tab.frames.subFrames {
                if budget <= 0 { break }
                guard
                    let frameText = try? await tab.bridge.call(
                        "return __lykn.extractFrameText();", in: entry.frame
                    ) as? String
                else { continue }
                let trimmed = frameText.trimmingCharacters(in: .whitespacesAndNewlines)
                // Tiny frames are ad pixels / widgets — skip the noise.
                guard trimmed.count >= 40 else { continue }
                extra.append(String(trimmed.prefix(budget)))
                budget -= trimmed.count
            }
            if !extra.isEmpty {
                text = String(
                    ("\(text)\n\(extra.joined(separator: "\n"))")
                        .trimmingCharacters(in: .whitespacesAndNewlines).prefix(16000)
                )
            }
        }
        return PageText(url: main.url, title: main.title, text: text)
    }

    private func viewportMetrics(tab: BrowserTab) async -> ViewportMetrics {
        await tab.bridge.decoded(ViewportMetrics.self, "return __lykn.viewportMetrics();")
            ?? .fallback
    }

    // MARK: - Navigation

    public func navigate(_ url: String) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        defer { invalidate() }
        switch await tab.navigate(to: url) {
        case .ok:
            return ActionResult(ok: true, type: "navigate")
        case .blocked(let reason):
            return .failure(reason, hint: "Only http(s) URLs can be opened.")
        case .failed(let reason):
            return .failure(reason)
        }
    }

    public func goBack() async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        defer { invalidate() }
        guard tab.goBack() else { return .failure("cannot_go_back") }
        await tab.waitForLoad()
        return ActionResult(ok: true, type: "back")
    }

    public func goForward() async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        defer { invalidate() }
        guard tab.goForward() else { return .failure("cannot_go_forward") }
        await tab.waitForLoad()
        return ActionResult(ok: true, type: "forward")
    }

    public func currentURL() -> String {
        (try? activeTab())?.url ?? ""
    }

    // MARK: - Element resolution

    private struct ResolvedPoint {
        var x: Double
        var y: Double
        var label: String
        var via: String
    }

    /// A resolution either yields a live point or the exact `ActionResult` the
    /// agent should see — `element_obscured` and `element_not_relocated` are
    /// part of the contract, not generic errors.
    private enum PointResolution {
        case resolved(ResolvedPoint)
        case failed(ActionResult)
    }

    /// Re-resolve an element's LIVE position before acting on it.
    ///
    /// Catalog coordinates go stale the moment the page scrolls or re-renders,
    /// and below-fold items sit outside the viewport entirely, so nothing acts
    /// on remembered coordinates without checking first.
    private func resolveLivePoint(
        tab: BrowserTab,
        element: SnapshotElement,
        strict: Bool = true,
        minLabelScore: Int = 80
    ) async -> PointResolution {
        let frame = tab.frames.frame(for: element.raw.frameId)
        let arguments: [String: Any] = [
            "spec": [
                "selector": element.raw.selector,
                "label": element.label,
                "strictTarget": strict,
                "minLabelScore": minLabelScore,
            ] as [String: Any]
        ]
        let result = await tab.bridge.dictionary(
            "return __lykn.resolveStrict(spec);", arguments: arguments, in: frame
        )

        guard let result else { return .failed(.failure("frame_gone")) }
        if result["ok"] as? Bool != true {
            let error = result["error"] as? String ?? "element_not_relocated"
            // Strict callers never guess: a covered target means a dialog or
            // menu is in the way, and an unresolvable one means the page
            // changed since the snapshot — both need a re-observe.
            let hint =
                error == "element_obscured"
                ? "Another element covers the target (open dialog or menu?) — re-observe the page first."
                : "The element from the last snapshot no longer resolves — the page changed; re-observe."
            return .failed(.failure(error, hint: hint))
        }

        var x = result["x"] as? Double ?? 0
        var y = result["y"] as? Double ?? 0
        // Coordinates from inside a frame are frame-local; the backend acts in
        // top-level page space.
        if frame != nil, let offset = tab.frames.offset(for: element.raw.frameId) {
            x += offset.x
            y += offset.y
        } else if frame != nil {
            // Offset unmeasured — coordinate actuation would mis-aim, so the
            // caller must stay inside the frame.
            return .failed(.failure("frame_offset_unknown"))
        }

        return .resolved(
            ResolvedPoint(
                x: x, y: y,
                label: result["label"] as? String ?? "",
                via: result["via"] as? String ?? ""
            )
        )
    }

    // MARK: - Click

    public func click(_ ref: String) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let element: SnapshotElement
        switch resolveRef(ref) {
        case .success(let value): element = value
        case .failure(let error): return .failure(error.rawValue)
        }

        // Clicks routinely change the page (navigation, dialogs, menus) — force
        // a re-observe before the next element interaction.
        defer { invalidate() }

        switch await resolveLivePoint(tab: tab, element: element) {
        case .resolved(let point):
            var result = await backend.click(at: CGPoint(x: point.x, y: point.y), target: tab)
            result.resolved = point.via.isEmpty ? "live" : point.via
            result.clickedLabel = point.label
            return result
        case .failed(let error):
            // A frame whose offset we could not measure still gets acted on —
            // inside the frame, synthetically, which is at least the right
            // element.
            if error.error == "frame_offset_unknown",
                let frame = tab.frames.frame(for: element.raw.frameId) {
                let inFrame = await tab.bridge.dictionary(
                    "var p = __lykn.resolveStrict(spec); if (!p.ok) return p; return __lykn.clickAt(p.x, p.y);",
                    arguments: [
                        "spec": [
                            "selector": element.raw.selector, "label": element.label,
                            "strictTarget": true, "minLabelScore": 80,
                        ] as [String: Any]
                    ],
                    in: frame
                )
                if let inFrame, inFrame["ok"] as? Bool == true {
                    return ActionResult(
                        ok: true, type: "click", resolved: "in_frame_synthetic",
                        clickedLabel: inFrame["label"] as? String ?? "", via: "js_synthetic"
                    )
                }
            }
            return error
        }
    }

    /// Click a point read off the screenshot (0–1000 in each axis).
    public func clickCoord(x: Double, y: Double, label: String) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        guard x.isFinite, y.isFinite else { return .failure("bad_coords") }
        defer { invalidate() }

        let metrics = await viewportMetrics(tab: tab)
        var mapped = CoordinateMapper.mapNormalizedToClient(
            nx: x, ny: y, metrics: metrics, shot: tab.lastScreenshot
        )

        // Snap only to a nearby control whose label matches the agent's target.
        let catalog = currentSnapshot?.elements.map(\.raw) ?? []
        let snapped = CoordinateMapper.snapToCatalog(
            x: mapped.x, y: mapped.y, catalog: catalog, radius: 28, labelHint: label
        )
        if snapped.snapped, !snapped.id.isEmpty || !snapped.label.isEmpty {
            if let item = catalog.first(where: { $0.id == snapped.id }),
                let element = currentSnapshot?.elements.first(where: { $0.raw.id == item.id }),
                case .resolved(let live) = await resolveLivePoint(
                    tab: tab, element: element, strict: false, minLabelScore: 1
                ) {
                mapped.x = live.x
                mapped.y = live.y
            } else {
                mapped.x = snapped.x
                mapped.y = snapped.y
            }
        }

        var result = await backend.click(at: CGPoint(x: mapped.x, y: mapped.y), target: tab)
        result.resolved = snapped.snapped ? "coord_snapped" : "coord"
        return result
    }

    // MARK: - Drag

    public func drag(from: DragEndpoint, to: DragEndpoint) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        defer { invalidate() }

        // HTML5 drag-and-drop first when the source opts into it: the browser's
        // own drag controller does not pick up synthetic pointer drags, so
        // anything using draggable="true" needs the event sequence dispatched
        // directly. This path works identically on both platforms.
        if case .ref(let sourceRef) = from, case .ref(let targetRef) = to,
            case .success(let source) = resolveRef(sourceRef),
            case .success(let target) = resolveRef(targetRef),
            source.raw.frameId == target.raw.frameId {
            let frame = tab.frames.frame(for: source.raw.frameId)
            let usesHTML5 =
                (try? await tab.bridge.call(
                    "return __lykn.usesHtml5Drag(selector);",
                    arguments: ["selector": source.raw.selector], in: frame
                )) as? Bool == true
            if usesHTML5 {
                let result = await tab.bridge.dictionary(
                    "return __lykn.html5Drag(from, to);",
                    arguments: ["from": source.raw.selector, "to": target.raw.selector],
                    in: frame
                )
                if let result, result["ok"] as? Bool == true {
                    return ActionResult(ok: true, type: "drag", via: "html5")
                }
            }
        }

        guard let start = await point(for: from, tab: tab) else {
            return .failure("drag source: could not resolve")
        }
        guard let end = await point(for: to, tab: tab) else {
            return .failure("drop target: could not resolve")
        }
        return await backend.drag(from: start, to: end, steps: 20, target: tab)
    }

    private func point(for endpoint: DragEndpoint, tab: BrowserTab) async -> CGPoint? {
        switch endpoint {
        case .ref(let ref):
            guard case .success(let element) = resolveRef(ref) else { return nil }
            guard case .resolved(let live) = await resolveLivePoint(
                tab: tab, element: element, strict: false, minLabelScore: 1
            ) else { return nil }
            return CGPoint(x: live.x, y: live.y)
        case .coordinate(let x, let y):
            guard x.isFinite, y.isFinite else { return nil }
            let metrics = await viewportMetrics(tab: tab)
            let mapped = CoordinateMapper.mapNormalizedToClient(
                nx: x, ny: y, metrics: metrics, shot: tab.lastScreenshot
            )
            return CGPoint(x: mapped.x, y: mapped.y)
        }
    }

    // MARK: - Typing

    public func type(
        _ ref: String,
        text: String,
        pressEnter: Bool,
        mode: TypeMode
    ) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let element: SnapshotElement
        switch resolveRef(ref) {
        case .success(let value): element = value
        case .failure(let error): return .failure(error.rawValue)
        }
        // Typing changes field values that the catalog now displays — decide
        // the next step from a fresh snapshot, or the model sees pre-typing
        // "empty" fields and fills them again (duplicated email bodies).
        defer { invalidate() }

        let tag = element.raw.tag.lowercased()
        if mode == .replace, tag != "input", tag != "textarea" {
            // An EMPTY rich-text field has nothing to replace — "replace" and
            // "append" are the same action, so fall through to typing rather
            // than burning a round on an error the model has to reinterpret.
            if !element.raw.value.trimmingCharacters(in: .whitespaces).isEmpty {
                return .failure(
                    "replace_mode_unsupported",
                    hint:
                        "This is a rich-text area with content — use replace_text to edit the specific passage instead of replacing everything."
                )
            }
        }

        let frame = tab.frames.frame(for: element.raw.frameId)
        let function = (mode == .replace && (tag == "input" || tag == "textarea"))
            ? "fillInto" : "typeInto"
        let result = await tab.bridge.dictionary(
            "return __lykn.\(function)(spec);",
            arguments: [
                "spec": [
                    "selector": element.raw.selector,
                    "label": element.label,
                    "text": text,
                    "mode": mode.rawValue,
                ] as [String: Any]
            ],
            in: frame
        )

        guard let result, result["ok"] as? Bool == true else {
            return .failure((result?["error"] as? String) ?? "type_failed")
        }

        if pressEnter {
            try? await Task.sleep(for: .milliseconds(100))
            _ = await backend.pressKey("Enter", modifiers: [], target: tab)
        }

        return ActionResult(
            ok: true,
            type: "click_type",
            verified: result["verified"] as? Bool == true,
            unverified: result["unverified"] as? Bool == true,
            via: result["via"] as? String ?? "js_ladder"
        )
    }

    /// Already pure page JS with no actuator involvement, so this ports
    /// verbatim — only how the frame handle is obtained changed.
    public func replaceText(_ ref: String, find findText: String, replace: String) async
        -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let element: SnapshotElement
        switch resolveRef(ref) {
        case .success(let value): element = value
        case .failure(let error): return .failure(error.rawValue)
        }
        guard !findText.trimmingCharacters(in: .whitespaces).isEmpty else {
            return .failure("missing_find_text")
        }

        let frame = tab.frames.frame(for: element.raw.frameId)
        let result = await tab.bridge.dictionary(
            "return __lykn.replaceText(selector, find, replacement);",
            arguments: [
                "selector": element.raw.selector, "find": findText, "replacement": replace,
            ],
            in: frame
        )
        guard let result else { return .failure("frame_gone") }
        guard result["ok"] as? Bool == true else {
            return .failure(
                result["error"] as? String ?? "replace_failed",
                hint: result["hint"] as? String ?? ""
            )
        }
        invalidate()
        return ActionResult(
            ok: true,
            type: "replace_text",
            replaced: true,
            preview: result["preview"] as? String ?? ""
        )
    }

    public func select(_ ref: String, value: String) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let element: SnapshotElement
        switch resolveRef(ref) {
        case .success(let el): element = el
        case .failure(let error): return .failure(error.rawValue)
        }
        defer { invalidate() }

        let frame = tab.frames.frame(for: element.raw.frameId)
        // Setting .value and dispatching change is the ONLY strategy that
        // works: WebKit renders <select> menus natively and no amount of event
        // synthesis opens one. Fortunately it is what the Electron build
        // already did.
        let result = await tab.bridge.dictionary(
            "return __lykn.selectOption(spec);",
            arguments: [
                "spec": [
                    "selector": element.raw.selector, "label": element.label, "value": value,
                ] as [String: Any]
            ],
            in: frame
        )
        guard let result, result["ok"] as? Bool == true else {
            return .failure((result?["error"] as? String) ?? "select_failed")
        }
        return ActionResult(ok: true, type: "select", value: result["value"] as? String)
    }

    public func extract(_ ref: String) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let element: SnapshotElement
        switch resolveRef(ref) {
        case .success(let value): element = value
        case .failure(let error): return .failure(error.rawValue)
        }
        let frame = tab.frames.frame(for: element.raw.frameId)
        guard
            let result = await tab.bridge.dictionary(
                "return __lykn.extract(selector);",
                arguments: ["selector": element.raw.selector], in: frame
            )
        else { return .failure("element_not_found") }
        return ActionResult(
            ok: true,
            type: "extract",
            value: result["value"] as? String,
            label: element.label,
            checked: result["checked"] as? Bool
        )
    }

    // MARK: - Scroll / keys

    public func scroll(direction: ScrollDirection, amount: Double, ref: String) async
        -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let delta = direction == .up ? -amount : amount

        if !ref.isEmpty {
            let element: SnapshotElement
            switch resolveRef(ref) {
            case .success(let value): element = value
            case .failure(let error): return .failure(error.rawValue)
            }
            let frame = tab.frames.frame(for: element.raw.frameId)
            let result = await tab.bridge.dictionary(
                "return __lykn.scrollElement(selector, dy, 0);",
                arguments: ["selector": element.raw.selector, "dy": delta], in: frame
            )
            guard let result, result["ok"] as? Bool == true else {
                return .failure((result?["error"] as? String) ?? "scroll_failed")
            }
            return ActionResult(ok: true, type: "scroll_element")
        }

        _ = await tab.bridge.dictionary(
            "return __lykn.scrollWindow(dy);", arguments: ["dy": delta]
        )
        // Carried over from the Electron controller: `scroll` is the one
        // mutating action that does NOT invalidate the snapshot, so refs stay
        // usable across a scroll. Live re-resolution before every action is
        // what makes that safe — cached coordinates are never trusted.
        return ActionResult(ok: true, type: "scroll")
    }

    public func pressKey(_ key: String, modifiers: [String]) async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let result = await backend.pressKey(key, modifiers: modifiers, target: tab)
        // Shortcuts are how design and editor tools are really driven, and most
        // of them change the page as much as a click does.
        if key.lowercased() == "enter" || !modifiers.isEmpty { invalidate() }
        return result
    }

    // MARK: - Tabs

    public func openTab(_ url: String) async -> ActionResult {
        defer { invalidate() }
        do {
            let tab = try tabs.openTab(url: url)
            await tab.waitForLoad()
            return ActionResult(ok: true, type: "open_tab", label: tab.id)
        } catch {
            return .failure(
                (error as? TabManager.TabError)?.errorDescription ?? "open_tab_failed"
            )
        }
    }

    public func closeTab(_ tabId: String?) async -> ActionResult {
        defer { invalidate() }
        return tabs.closeTab(tabId)
            ? ActionResult(ok: true, type: "close_tab")
            : .failure("unknown_tab")
    }

    public func switchTab(_ tabId: String?) async -> ActionResult {
        defer { invalidate() }
        return tabs.activate(tabId)
            ? ActionResult(ok: true, type: "switch_tab")
            : .failure("unknown_tab")
    }

    public func listTabs() async -> [TabInfo] { tabs.tabInfos() }

    // MARK: - Misc

    public func wait(ms: Double) async -> ActionResult {
        let clamped = min(max(ms.isFinite ? ms : 800, 100), 10000)
        try? await Task.sleep(for: .milliseconds(Int(clamped)))
        return ActionResult(ok: true, type: "wait", ms: clamped)
    }

    public func screenshot() async -> ActionResult {
        guard let tab = try? activeTab() else { return .failure("browser_gone") }
        let metrics = await viewportMetrics(tab: tab)
        guard let capture = await SnapshotCapture.captureViewport(tab: tab, metrics: metrics)
        else { return .failure("screenshot_failed") }
        // Recorded here and nowhere else: click_coord and drag read it back to
        // turn the model's 0–1000 coordinates into CSS pixels.
        tab.lastScreenshot = capture.meta
        return ActionResult(ok: true, type: "screenshot", dataUrl: capture.dataURL)
    }
}
