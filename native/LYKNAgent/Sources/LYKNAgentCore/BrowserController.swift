import Foundation

/// Deterministic browser controller — **the seam**.
///
/// The LLM decides WHAT should happen; a conforming type decides HOW the
/// browser operation is executed. Everything above this protocol (planner,
/// executor, verifier, task state, memory, vision policy) is environment
/// agnostic, which is exactly what makes the WKWebView port possible: the
/// Electron implementation and `LYKNWebKit.WebKitBrowserController` differ
/// entirely below this line and not at all above it.
///
/// Ported from the interface of
/// `electron/browser-agent/browser/controller.cjs`.
public protocol BrowserController: AnyObject {
    /// Capture a fresh structured snapshot. This is the ONLY way the agent
    /// sees the page; element refs are minted here and die on the next
    /// navigation.
    func getPageState() async throws -> PageSnapshot

    /// The last snapshot, or nil when it has been invalidated by a mutating
    /// action. Never returns a stale view.
    func getCurrentSnapshot() async -> PageSnapshot?

    /// Mark the current snapshot stale — refs from it stop resolving.
    func invalidate() async

    /// Best-effort wait for load + DOM quiescence.
    func settle(timeoutMs: Int) async

    // MARK: Navigation
    func navigate(_ url: String) async -> ActionResult
    func goBack() async -> ActionResult
    func goForward() async -> ActionResult

    // MARK: Element actions
    func click(_ ref: String) async -> ActionResult
    func type(_ ref: String, text: String, pressEnter: Bool, mode: TypeMode) async -> ActionResult
    /// Targeted in-place edit: find `findText` inside the element and replace
    /// only that occurrence, preserving everything else. This is the right tool
    /// for revisions — never retype a whole document to change one passage.
    func replaceText(_ ref: String, find findText: String, replace: String) async -> ActionResult
    func select(_ ref: String, value: String) async -> ActionResult
    /// Read an element's live value/text — the evidence for form verification.
    func extract(_ ref: String) async -> ActionResult

    // MARK: Spatial actions
    /// Click a point read off the screenshot (0–1000 in each axis). The escape
    /// hatch for anything the DOM cannot describe: canvas editors, image maps,
    /// custom-drawn controls.
    func clickCoord(x: Double, y: Double, label: String) async -> ActionResult
    /// Drag one element onto another. Both ends may be element refs or 0–1000
    /// screenshot coordinates, so this works on canvas editors where the drop
    /// target has no DOM presence at all.
    func drag(from: DragEndpoint, to: DragEndpoint) async -> ActionResult
    /// A ref means "scroll inside this thing" — editor palettes, block lists
    /// and side panels scroll internally and ignore window scrolling entirely.
    func scroll(direction: ScrollDirection, amount: Double, ref: String) async -> ActionResult
    func pressKey(_ key: String, modifiers: [String]) async -> ActionResult

    // MARK: Tabs
    func openTab(_ url: String) async -> ActionResult
    func closeTab(_ tabId: String?) async -> ActionResult
    func switchTab(_ tabId: String?) async -> ActionResult
    func listTabs() async -> [TabInfo]

    // MARK: Misc
    func wait(ms: Double) async -> ActionResult
    func screenshot() async -> ActionResult
    func currentURL() async -> String
}

public enum TypeMode: String, Sendable {
    case append
    case replace
}

public enum ScrollDirection: String, Sendable {
    case up
    case down
}

public enum DragEndpoint: Sendable, Equatable {
    case ref(String)
    /// 0–1000 normalized screenshot coordinates.
    case coordinate(x: Double, y: Double)
}

/// Errors a controller raises rather than reporting as an `ActionResult`.
public struct BrowserGoneError: LocalizedError, Sendable {
    public var errorDescription: String? { "browser_gone" }
    public init() {}
}

public extension BrowserController {
    /// Map a structured decision action onto the controller's deterministic
    /// API. Ported from `executeAction` in
    /// `electron/browser-agent/index.cjs:618`.
    func execute(_ action: AgentAction?) async -> ActionResult {
        guard let action else { return .failure("unknown_action_type:") }
        switch action.type {
        case "navigate":
            return await navigate(action.url ?? "")
        case "click":
            return await click(action.target ?? "")
        case "click_coord":
            // No label hint: the decision schema has no `label` field, and
            // feeding it `text` would let `snapClientPointToCatalog` steal the
            // click onto whatever nearby control happened to match.
            return await clickCoord(x: action.x ?? .nan, y: action.y ?? .nan, label: "")
        case "drag":
            let source: DragEndpoint =
                (action.target?.isEmpty == false)
                ? .ref(action.target!) : .coordinate(x: action.x ?? .nan, y: action.y ?? .nan)
            let destination: DragEndpoint =
                (action.to?.isEmpty == false)
                ? .ref(action.to!) : .coordinate(x: action.toX ?? .nan, y: action.toY ?? .nan)
            return await drag(from: source, to: destination)
        case "type":
            return await type(
                action.target ?? "",
                text: action.effectiveText,
                pressEnter: action.pressEnter == true,
                mode: action.mode == "replace" ? .replace : .append
            )
        case "replace_text":
            return await replaceText(
                action.target ?? "", find: action.find ?? "", replace: action.effectiveText
            )
        case "select":
            return await select(action.target ?? "", value: action.value ?? action.text ?? "")
        case "scroll":
            return await scroll(
                direction: action.direction == "up" ? .up : .down,
                amount: 600,
                ref: action.target ?? ""
            )
        case "go_back":
            return await goBack()
        case "go_forward":
            return await goForward()
        case "press_key":
            return await pressKey(action.key ?? "Enter", modifiers: action.modifiers ?? [])
        case "open_tab":
            return await openTab(action.url ?? "")
        case "close_tab":
            return await closeTab(action.tabId)
        case "switch_tab":
            return await switchTab(action.tabId)
        case "extract":
            return await extract(action.target ?? "")
        case "wait":
            return await wait(ms: action.ms ?? 800)
        case "screenshot":
            return await screenshot()
        default:
            return .failure("unknown_action_type:\(action.type)")
        }
    }
}
