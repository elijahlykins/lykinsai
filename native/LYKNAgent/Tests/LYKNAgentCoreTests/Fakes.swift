import Foundation

@testable import LYKNAgentCore

/// A model that returns scripted decisions, so loop behavior can be tested
/// without a network or a provider.
final class FakeAgentModel: AgentModel, @unchecked Sendable {
    var planResult = PlanResult(plan: ["Do the thing"])
    var verifyResult = VerifyResult(success: true, evidence: "looks right", next: .cont)
    var learnResult = LearnResult(notes: [])
    /// Consumed in order; the last one repeats once exhausted.
    var decisions: [AgentDecision] = []

    private(set) var decideCount = 0
    private(set) var planCount = 0
    private(set) var learnCount = 0
    private(set) var lastDecideUser = ""

    func plan(system: String, user: String) async throws -> PlanResult {
        planCount += 1
        return planResult
    }

    func decide(system: String, user: String, imageUrl: String?) async throws -> AgentDecision {
        decideCount += 1
        lastDecideUser = user
        guard !decisions.isEmpty else {
            return AgentDecision(kind: .finish, answer: "Done.")
        }
        let next = decisions.count > 1 ? decisions.removeFirst() : decisions[0]
        return next
    }

    func learn(system: String, user: String) async throws -> LearnResult {
        learnCount += 1
        return learnResult
    }

    func verify(system: String, user: String) async throws -> VerifyResult {
        verifyResult
    }
}

/// A controller that reports a fixed page and records what was asked of it.
final class FakeBrowserController: BrowserController, @unchecked Sendable {
    var url = "https://example.test"
    var title = "Example"
    var catalog: [CatalogItem] = [
        CatalogItem(id: "el0", tag: "button", role: "button", label: "Send")
    ]
    var visibleText = "a page"

    /// Each `getPageState` bumps this so snapshots differ and the diff is
    /// non-empty when a test wants observable change.
    var mutateOnObserve = false

    private var snapshot: PageSnapshot?
    private var stale = true
    private(set) var executed: [String] = []
    private(set) var screenshotCount = 0

    func getPageState() async throws -> PageSnapshot {
        if mutateOnObserve { visibleText += "." }
        let built = SnapshotBuilder.buildSnapshot(
            url: url, title: title, catalog: catalog, text: visibleText,
            tabs: [TabInfo(id: "tab-1", url: url, title: title, active: true)]
        )
        snapshot = built
        stale = false
        return built
    }

    func getCurrentSnapshot() async -> PageSnapshot? { stale ? nil : snapshot }
    func invalidate() async { stale = true }
    func settle(timeoutMs: Int) async {}

    func navigate(_ url: String) async -> ActionResult {
        executed.append("navigate:\(url)")
        self.url = url
        await invalidate()
        return ActionResult(ok: true, type: "navigate")
    }

    func goBack() async -> ActionResult { record("go_back") }
    func goForward() async -> ActionResult { record("go_forward") }
    func click(_ ref: String) async -> ActionResult { record("click:\(ref)") }

    func type(_ ref: String, text: String, pressEnter: Bool, mode: TypeMode) async -> ActionResult {
        record("type:\(ref):\(text)")
    }

    func replaceText(_ ref: String, find: String, replace: String) async -> ActionResult {
        executed.append("replace_text:\(ref)")
        return ActionResult(ok: true, type: "replace_text", replaced: true, preview: replace)
    }

    func select(_ ref: String, value: String) async -> ActionResult { record("select:\(ref)") }

    func extract(_ ref: String) async -> ActionResult {
        executed.append("extract:\(ref)")
        return ActionResult(ok: true, type: "extract", value: "field contents", label: "Send")
    }

    func clickCoord(x: Double, y: Double, label: String) async -> ActionResult {
        // The dispatch layer passes `.nan` when the model omitted coordinates;
        // a real controller rejects that, so the fake must not crash on it.
        guard x.isFinite, y.isFinite else {
            executed.append("click_coord:bad")
            return .failure("bad_coords")
        }
        return record("click_coord:\(Int(x)),\(Int(y))")
    }

    func drag(from: DragEndpoint, to: DragEndpoint) async -> ActionResult { record("drag") }

    func scroll(direction: ScrollDirection, amount: Double, ref: String) async -> ActionResult {
        record("scroll:\(direction.rawValue)")
    }

    func pressKey(_ key: String, modifiers: [String]) async -> ActionResult {
        record("press_key:\(key)")
    }

    func openTab(_ url: String) async -> ActionResult { record("open_tab") }
    func closeTab(_ tabId: String?) async -> ActionResult { record("close_tab") }
    func switchTab(_ tabId: String?) async -> ActionResult { record("switch_tab") }
    func listTabs() async -> [TabInfo] {
        [TabInfo(id: "tab-1", url: url, title: title, active: true)]
    }

    func wait(ms: Double) async -> ActionResult { ActionResult(ok: true, type: "wait", ms: ms) }

    func screenshot() async -> ActionResult {
        screenshotCount += 1
        return ActionResult(ok: true, type: "screenshot", dataUrl: "data:image/jpeg;base64,AAA")
    }

    func currentURL() async -> String { url }

    private func record(_ label: String) -> ActionResult {
        executed.append(label)
        Task { await invalidate() }
        return ActionResult(ok: true, type: label)
    }
}
