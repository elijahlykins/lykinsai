import AppKit
import Foundation
import LYKNAgentCore
import LYKNWebKit
import WebKit

/// Actuation smoke test against real websites.
///
/// The agent's *brain* is covered by unit tests with a fake controller. What
/// those cannot cover is the half this port actually rewrote: whether a
/// catalog collected from real markup resolves, whether a synthesized or
/// trusted click lands, whether the typing ladder survives a live search box,
/// and whether the 0–1000 coordinate chain aims where it claims to.
///
/// So this drives the real `WebKitBrowserController` through a scripted
/// sequence and checks the result of each step. No model is involved — every
/// decision here is hard-coded, so a failure is an actuation failure and
/// nothing else.
///
/// Sites are chosen to need no login. One page is served locally, because no
/// convenient public page offers a `<select>`, a checkbox and a text field
/// together.

// MARK: - Reporting

@MainActor
final class Report {
    struct Row {
        let scenario: String
        let step: String
        let ok: Bool
        let detail: String
    }

    private(set) var rows: [Row] = []
    private var scenario = ""

    func begin(_ name: String) {
        scenario = name
        print("\n── \(name)")
    }

    @discardableResult
    func check(_ step: String, _ ok: Bool, _ detail: String = "") -> Bool {
        rows.append(Row(scenario: scenario, step: step, ok: ok, detail: detail))
        print("  \(ok ? "PASS" : "FAIL")  \(step)\(detail.isEmpty ? "" : "  — \(detail)")")
        return ok
    }

    func note(_ text: String) { print("        \(text)") }

    func summary() -> Int {
        let failed = rows.filter { !$0.ok }
        print("\n═══ \(rows.count - failed.count)/\(rows.count) passed")
        if !failed.isEmpty {
            print("failed steps:")
            for row in failed {
                print("  · \(row.scenario) / \(row.step)\(row.detail.isEmpty ? "" : " — \(row.detail)")")
            }
        }
        return failed.count
    }
}

// MARK: - Helpers

extension PageSnapshot {
    func first(
        role: String? = nil,
        labelContains: String? = nil,
        tag: String? = nil
    ) -> SnapshotElement? {
        elements.first { element in
            if let role, element.role != role { return false }
            if let tag, element.raw.tag.lowercased() != tag { return false }
            if let labelContains,
                !element.label.lowercased().contains(labelContains.lowercased()) {
                return false
            }
            return true
        }
    }
}

// MARK: - Harness

@MainActor
final class Harness {
    let report = Report()
    private var window: NSWindow!
    private var container: NSView!
    fileprivate var tabs: TabManager!
    private var controller: WebKitBrowserController!
    private let backend = NativeEventBackend()

    func setUp() async {
        container = NSView(frame: NSRect(x: 0, y: 0, width: 1440, height: 900))
        container.autoresizingMask = [.width, .height]

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentView = container
        window.title = "LYKN actuation smoke test"
        // Trusted NSEvent delivery goes through the responder chain of a key
        // window in an active app; without this the backend silently falls
        // back to JS synthesis and the test would report the wrong thing.
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        let profile = ProfileStore(
            defaults: UserDefaults(suiteName: "lykn-actuate-\(UUID().uuidString)") ?? .standard
        )
        tabs = TabManager(profile: profile, container: container)
        await tabs.prepare()
        controller = WebKitBrowserController(tabs: tabs, backend: backend)
        _ = try? tabs.openTab()
        try? await Task.sleep(for: .milliseconds(300))
    }

    private func settle(_ ms: Int = 2500) async {
        await controller.settle(timeoutMs: ms)
        try? await Task.sleep(for: .milliseconds(400))
    }

    private func observe() async -> PageSnapshot? {
        try? await controller.getPageState()
    }

    // MARK: Scenario 0 — the user agent names a browser

    /// The UA is the one piece of the port that every site reads before it
    /// serves a byte. A WKWebView that names no browser and no version gets a
    /// degraded page — Google Docs measurably so — and nothing else in this
    /// suite would notice, because every request still succeeds.
    func scenarioUserAgent() async {
        report.begin("user agent — names a browser and a version")
        _ = await controller.navigate("https://example.com")
        await settle()

        guard let tab = tabs.activeTab else {
            report.check("active tab", false, "")
            return
        }
        let ua = (try? await tab.bridge.call("return navigator.userAgent;")) as? String ?? ""
        report.note(ua.isEmpty ? "(user agent unreadable)" : ua)

        report.check("Version/ token present", ua.contains("Version/"), ua)
        report.check(
            "Safari/\(SafariUserAgent.webKitBuild) token present",
            ua.contains("Safari/\(SafariUserAgent.webKitBuild)"), ua
        )
        // hasSuffix, not contains: anything appended after the Safari tokens —
        // an app name, a build id — is a fingerprint that sets this browser
        // apart from every other Safari on the web.
        report.check(
            "nothing appended after the Safari tokens",
            ua.hasSuffix(SafariUserAgent.applicationName),
            "expected UA to end with \"\(SafariUserAgent.applicationName)\""
        )
    }

    // MARK: Scenario 1 — observation on a real page

    func scenarioObservation() async {
        report.begin("example.com — observation")
        let navigated = await controller.navigate("https://example.com")
        report.check("navigate ok", navigated.ok, navigated.error)
        await settle()

        guard let snapshot = await observe() else {
            report.check("snapshot captured", false, "getPageState threw")
            return
        }
        report.check("snapshot captured", true, "\(snapshot.elements.count) elements")
        report.check(
            "url resolved", snapshot.url.contains("example.com"), snapshot.url
        )
        report.check(
            "page text scraped",
            snapshot.visibleText.lowercased().contains("example domain"),
            "\(snapshot.visibleText.count) chars"
        )
        report.check("title read", !snapshot.title.isEmpty, snapshot.title)

        if let link = snapshot.first(role: "link") {
            let extracted = await controller.extract(link.ref)
            report.check(
                "extract on a real element", extracted.ok,
                "\(link.ref) \"\(link.label)\" → \(String((extracted.value ?? "").prefix(40)))"
            )
        } else {
            report.check("found a link to extract", false, "no link in catalog")
        }
    }

    // MARK: Scenario 2 — clicking a real link

    func scenarioClickLink() async {
        report.begin("wikipedia.org — click a link")
        _ = await controller.navigate("https://en.wikipedia.org/wiki/Web_browser")
        await settle()

        guard let snapshot = await observe() else {
            report.check("snapshot captured", false, "")
            return
        }
        report.check("catalog built on a large page", snapshot.elements.count > 20,
                     "\(snapshot.elements.count) elements")

        // A link that is stable on this article and in view.
        // A same-page fragment link ("(Top)", section anchors) navigates
        // nowhere, so it cannot demonstrate that a click landed.
        let currentPath = URL(string: snapshot.url)?.path ?? ""
        guard
            let link = snapshot.elements.first(where: {
                guard $0.role == "link", $0.inView, $0.label.count > 3,
                    !$0.raw.href.isEmpty, $0.raw.href.contains("/wiki/"),
                    let href = URL(string: $0.raw.href)
                else { return false }
                return href.fragment == nil && href.path != currentPath
            })
        else {
            report.check("found an in-view wiki link", false, "")
            return
        }
        let before = snapshot.url
        let clicked = await controller.click(link.ref)
        report.check(
            "click returned ok", clicked.ok,
            "\"\(link.label)\" via \(clicked.via.isEmpty ? "?" : clicked.via)"
        )
        report.note("backend reported: \(clicked.via) · resolved: \(clicked.resolved)")
        await settle()

        let after = await controller.currentURL()
        // "the URL changed" is not enough: a mis-aimed click on a dense page
        // still hits *a* link and still changes the URL. Assert we landed on
        // the link we aimed at.
        let wantedPath = URL(string: link.raw.href)?.path ?? "\u{0}"
        let landedPath = URL(string: after)?.path ?? ""
        report.check(
            "landed on the link we aimed at",
            after != before && landedPath == wantedPath,
            "aimed \(wantedPath) → landed \(landedPath)"
        )
    }

    // MARK: Scenario 3 — typing into a live search box

    func scenarioTypeAndSubmit() async {
        report.begin("duckduckgo.com — type + Enter")
        _ = await controller.navigate("https://duckduckgo.com")
        await settle()

        guard let snapshot = await observe() else {
            report.check("snapshot captured", false, "")
            return
        }
        guard
            let box = snapshot.first(role: "searchbox") ?? snapshot.first(role: "combobox")
                ?? snapshot.elements.first(where: {
                    $0.raw.tag.lowercased() == "input" && $0.role == "textbox"
                })
        else {
            report.check("found the search box", false,
                         "roles seen: \(Set(snapshot.elements.map(\.role)).sorted().joined(separator: ","))")
            return
        }
        report.check("found the search box", true, "\(box.ref) \"\(box.label)\"")

        let typed = await controller.type(
            box.ref, text: "wkwebview", pressEnter: true, mode: .append
        )
        report.check("type returned ok", typed.ok, typed.error)
        report.note(
            "verified=\(typed.verified) unverified=\(typed.unverified) via=\(typed.via)"
        )
        await settle(4000)

        let after = await controller.currentURL()
        report.check(
            "search submitted (URL carries the query)",
            after.lowercased().contains("wkwebview"),
            after
        )
    }

    // MARK: Scenario 4 — form controls

    func scenarioFormControls() async {
        report.begin("local /form — text, select, checkbox, submit")
        let navigated = await controller.navigate("http://127.0.0.1:8787/form")
        guard navigated.ok else {
            report.check("navigate to local form", false,
                         "\(navigated.error) — is `node native/bench/server.mjs` running?")
            return
        }
        await settle()

        // Every mutating action invalidates the snapshot, so each step
        // re-observes first. This mirrors the agent loop, which never reuses a
        // ref across an action.
        func fresh(
            _ label: String,
            _ match: @escaping (SnapshotElement) -> Bool
        ) async -> SnapshotElement? {
            guard let snapshot = await observe() else {
                report.check("re-observe for \(label)", false, "getPageState threw")
                return nil
            }
            guard let element = snapshot.elements.first(where: match) else {
                report.check("find \(label)", false, "not in catalog")
                return nil
            }
            return element
        }

        if let name = await fresh("text input", { $0.raw.tag == "input" && $0.raw.type == "text" }) {
            let typed = await controller.type(
                name.ref, text: "Ada Lovelace", pressEnter: false, mode: .replace
            )
            report.check("type into text input", typed.ok && typed.verified,
                         "verified=\(typed.verified) via=\(typed.via)")
        }

        // WebKit renders <select> menus natively, so setting .value and
        // dispatching change is the only strategy that can work at all.
        if let combo = await fresh("select", { $0.raw.tag == "select" }) {
            let selected = await controller.select(combo.ref, value: "green")
            report.check("select an option", selected.ok && selected.value == "green",
                         "value=\(selected.value ?? "nil") \(selected.error)")
        }

        if let notes = await fresh("textarea", { $0.raw.tag == "textarea" }) {
            let typed = await controller.type(
                notes.ref, text: "first line", pressEnter: false, mode: .append
            )
            report.check("type into textarea", typed.ok, typed.error)
        }

        if let notes = await fresh("textarea again", { $0.raw.tag == "textarea" }) {
            let replaced = await controller.replaceText(
                notes.ref, find: "first", replace: "second"
            )
            report.check("replace_text in place", replaced.ok && replaced.replaced,
                         replaced.error.isEmpty ? replaced.preview : replaced.error)
        }

        if let agree = await fresh("checkbox", { $0.raw.type == "checkbox" }) {
            let clicked = await controller.click(agree.ref)
            report.check("click a checkbox", clicked.ok, "\(clicked.via) \(clicked.error)")
            if let again = await fresh("checkbox after click", { $0.raw.type == "checkbox" }) {
                report.check("checkbox actually toggled", again.checked,
                             "checked=\(again.checked)")
            }
        }

        if let submit = await fresh("submit button", {
            $0.raw.tag == "button" || $0.label.lowercased().contains("submit form")
        }) {
            let before = await controller.currentURL()
            let clicked = await controller.click(submit.ref)
            report.check("click submit", clicked.ok, "\(clicked.via) \(clicked.error)")
            await settle()
            let after = await controller.currentURL()
            report.check("form submitted with our values",
                         after != before && after.contains("colour=green")
                             && after.contains("Ada"),
                         after)
        }
    }

    // MARK: Scenario 5 — screenshot + coordinate chain

    func scenarioCoordinates() async {
        report.begin("news.ycombinator.com — scroll, screenshot, click_coord")
        _ = await controller.navigate("https://news.ycombinator.com")
        await settle()

        let shot = await controller.screenshot()
        report.check("screenshot captured", shot.ok && shot.dataUrl.hasPrefix("data:image/jpeg"),
                     "\(shot.dataUrl.count) chars")

        let scrolled = await controller.scroll(direction: .down, amount: 600, ref: "")
        report.check("window scroll", scrolled.ok, scrolled.error)
        await settle(1200)

        guard let snapshot = await observe() else {
            report.check("snapshot after scroll", false, "")
            return
        }
        report.check("snapshot after scroll", true, "\(snapshot.elements.count) elements")

        // The coordinate chain, end to end: take a real element's live client
        // position, convert it into the model's 0–1000 space exactly as the
        // model would read it off the screenshot, then click_coord and check we
        // hit that element rather than something near it.
        guard
            let target = snapshot.elements.first(where: {
                $0.role == "link" && $0.inView && $0.label.count > 8
                    && $0.raw.clientY > 100 && !$0.raw.href.isEmpty
            })
        else {
            report.check("found a target link for coordinate click", false, "")
            return
        }

        _ = await controller.screenshot()  // refresh lastScreenshotMeta
        let viewportWidth = 1440.0
        let viewportHeight = 900.0
        let nx = (target.raw.clientX / viewportWidth) * 1000
        let ny = (target.raw.clientY / viewportHeight) * 1000
        report.note(
            "target \"\(target.label)\" at client (\(Int(target.raw.clientX)),\(Int(target.raw.clientY))) → norm (\(Int(nx)),\(Int(ny)))"
        )

        // The element's own href carries its item id, so the resulting URL
        // proves which arrow was actually clicked — not just that one was.
        let wantedID =
            URLComponents(string: target.raw.href)?
            .queryItems?.first(where: { $0.name == "id" })?.value ?? ""
        let before = await controller.currentURL()
        let clicked = await controller.clickCoord(x: nx, y: ny, label: "")
        report.check("click_coord returned ok", clicked.ok, "resolved=\(clicked.resolved)")
        await settle(2500)
        let after = await controller.currentURL()
        report.check(
            "coordinate click hit the element we aimed at",
            after != before && !wantedID.isEmpty && after.contains("id=\(wantedID)"),
            "aimed id=\(wantedID) → \(after)"
        )
    }

    // MARK: Scenario 6 — injected runtime, entry point by entry point
    //
    // This is the regression net for the bug that made every catalog come back
    // empty: the runtime captured `window.getComputedStyle` unbound, so every
    // call threw and every result was silently discarded. It lives here rather
    // than in `swift test` because WKWebView's content process does not come
    // up in SPM's headless test host — `callAsyncJavaScript` never returns
    // there. A real NSApplication is the only place this can run.

    func scenarioRuntimeEntryPoints() async {
        report.begin("injected runtime — every entry point executes")
        let navigated = await controller.navigate("http://127.0.0.1:8787/fixture")
        guard navigated.ok else {
            report.check("navigate to fixture", false, navigated.error)
            return
        }
        await settle()

        guard let tab = tabs.activeTab else {
            report.check("active tab", false, "")
            return
        }
        let bridge = tab.bridge

        let probes: [(String, String)] = [
            ("collectInteractables", "return (__lykn.collectInteractables().items || []).length > 0;"),
            ("extractPageContext", "return __lykn.extractPageContext().text.length > 0;"),
            ("extractFrameText", "return typeof __lykn.extractFrameText() === 'string';"),
            ("collectFrameRects", "return Array.isArray(__lykn.collectFrameRects());"),
            ("viewportMetrics", "return __lykn.viewportMetrics().w > 0;"),
            ("resolvePoint", "return !!__lykn.resolvePoint({selector:'#alpha'});"),
            ("resolveStrict", "return __lykn.resolveStrict({selector:'#alpha'}).ok === true;"),
            ("topmostLabelAt", "return __lykn.topmostLabelAt(30, 30) !== undefined;"),
            ("usesHtml5Drag", "return __lykn.usesHtml5Drag('#alpha') === false;"),
            ("scrollElement", "return __lykn.scrollElement('#panel', 50, 0).ok === true;"),
            ("scrollWindow", "return __lykn.scrollWindow(10).ok === true;"),
            ("extract", "return !!__lykn.extract('#notes');"),
            ("typeInto", "return __lykn.typeInto({selector:'#name', text:'Ada'}).verified === true;"),
            ("replaceText", "return __lykn.replaceText('#notes','first','second').replaced === true;"),
            ("clickAt", "var p = __lykn.resolveStrict({selector:'#alpha'}); return __lykn.clickAt(p.x, p.y).ok === true;"),
            ("pressKey", "return __lykn.pressKey('a', []).ok === true;"),
            ("domSettle", "return (await __lykn.domSettle(300)).ok === true;"),
        ]

        var failures: [String] = []
        for (name, script) in probes {
            let value = (try? await bridge.call(script)) as? Bool
            if value != true { failures.append(name) }
        }
        report.check(
            "all \(probes.count) runtime entry points execute",
            failures.isEmpty,
            failures.isEmpty ? "" : "failed: \(failures.joined(separator: ", "))"
        )

        // State the catalog must report or the agent wastes rounds on it.
        if let snapshot = await observe() {
            let disabled = snapshot.elements.first { $0.label.contains("Beta") }
            report.check("disabled control flagged", disabled?.disabled == true,
                         "disabled=\(disabled?.disabled.description ?? "not found")")
            // Note the limitation this exposes, inherited unchanged from the
            // Electron collector: a scrollable container with no interactive
            // signal of its own (no role, tabindex or handler) is never
            // cataloged, so it can never be flagged. That is survivable
            // because `scrollElement` walks up to the nearest scrolling
            // ancestor, so scrolling any child of the panel still works — but
            // the model only *sees* the panel when it is focusable, as here.
            let scrollable = snapshot.elements.first { $0.scrollable }
            report.check("internally scrolling container flagged", scrollable != nil,
                         scrollable?.label ?? "not found")
        }
    }

    // MARK: Scenario 7 — staleness contract

    func scenarioStaleness() async {
        report.begin("staleness contract")
        _ = await controller.navigate("https://example.com")
        await settle()
        guard let snapshot = await observe(), let link = snapshot.first(role: "link") else {
            report.check("captured a ref to go stale", false, "")
            return
        }
        let ref = link.ref

        // Navigating invalidates the snapshot; the ref must stop resolving
        // rather than silently addressing whatever now sits at that index.
        _ = await controller.navigate("https://example.org")
        await settle()
        let result = await controller.click(ref)
        report.check("stale ref refused", !result.ok && result.error == "stale_reference",
                     "error=\(result.error)")

        _ = await observe()
        let unknown = await controller.click("e9999")
        report.check("unknown ref refused", !unknown.ok && unknown.error == "unknown_reference",
                     "error=\(unknown.error)")
    }

    func run() async -> Int {
        await setUp()
        print("backend: \(backend.name) (trusted=\(backend.producesTrustedEvents))")

        await scenarioUserAgent()
        await scenarioObservation()
        await scenarioClickLink()
        await scenarioTypeAndSubmit()
        await scenarioFormControls()
        await scenarioCoordinates()
        await scenarioRuntimeEntryPoints()
        await scenarioStaleness()

        return report.summary()
    }
}

// MARK: - Entry point

let application = NSApplication.shared
application.setActivationPolicy(.regular)

Task { @MainActor in
    let harness = Harness()
    let failures = await harness.run()
    exit(failures == 0 ? 0 : 1)
}
application.run()
