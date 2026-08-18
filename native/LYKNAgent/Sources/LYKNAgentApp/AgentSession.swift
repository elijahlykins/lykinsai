import AppKit
import Foundation
import LYKNAgentCore
import LYKNWebKit
import SwiftUI

/// Wires the brain to the browser and surfaces the run to SwiftUI.
///
/// The agent handles a stop as a **handover, not an ending**: the user is
/// watching the same tab, so when the run needs a credential, an approval, or
/// just a nudge, this publishes the request, waits, and resumes in place with a
/// fresh round budget rather than making them start over.
@MainActor
public final class AgentSession: ObservableObject {
    // MARK: Published state

    @Published public private(set) var status: String = "Idle"
    @Published public private(set) var narration: [NarrationLine] = []
    @Published public private(set) var plan: [String] = []
    @Published public private(set) var isRunning = false
    @Published public private(set) var tabs: [TabInfo] = []
    @Published public private(set) var answer: String = ""
    @Published public var pendingApproval: PendingApproval?
    @Published public var pendingHandover: PendingHandover?
    @Published public var backendName: String = ""

    public struct NarrationLine: Identifiable {
        public let id = UUID()
        public let text: String
        public let kind: Kind
        public enum Kind { case step, recovery, handover, result }
    }

    public struct PendingApproval: Identifiable {
        public let id = UUID()
        public let question: String
        let continuation: CheckedContinuation<Bool, Never>
    }

    public struct PendingHandover: Identifiable {
        public let id = UUID()
        public let question: String
        let continuation: CheckedContinuation<UserAssist?, Never>
    }

    // MARK: Browser stack

    public let profile: ProfileStore
    public let tabManager: TabManager
    public let containerView: NSView
    private let controller: WebKitBrowserController
    private let nativeBackend: NativeEventBackend
    private let jsBackend = JSSyntheticBackend()

    private var runTask: Task<Void, Never>?

    /// Where the model endpoint lives, and how to authenticate to it. The app
    /// holds no provider keys — calls go to the LYKN server's structured
    /// endpoint, exactly as the Electron build did.
    public struct ModelConfiguration {
        public var apiBase: String
        public var authToken: @Sendable () async -> String?

        public init(apiBase: String, authToken: @escaping @Sendable () async -> String?) {
            self.apiBase = apiBase
            self.authToken = authToken
        }

        /// Defaults from the environment so a dev build runs without a
        /// sign-in flow. `LYKN_API_BASE` / `LYKN_AGENT_TOKEN`.
        public static var fromEnvironment: ModelConfiguration {
            let environment = ProcessInfo.processInfo.environment
            let base = environment["LYKN_API_BASE"] ?? "https://lykn.io"
            let token = environment["LYKN_AGENT_TOKEN"]
            return ModelConfiguration(apiBase: base, authToken: { token })
        }
    }

    public var modelConfiguration: ModelConfiguration = .fromEnvironment

    public init() {
        profile = ProfileStore()
        containerView = NSView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800))
        containerView.autoresizingMask = [.width, .height]
        tabManager = TabManager(profile: profile, container: containerView)
        nativeBackend = NativeEventBackend()
        controller = WebKitBrowserController(tabs: tabManager, backend: nativeBackend)
        backendName = nativeBackend.name

        tabManager.onTabsChanged = { [weak self] in
            guard let self else { return }
            tabs = tabManager.tabInfos()
        }
        // Content rules must compile before the first tab exists, or that tab
        // ships without them.
        Task { @MainActor in
            await tabManager.prepare()
            _ = try? tabManager.openTab(url: "about:blank")
            tabs = tabManager.tabInfos()
        }
    }

    // MARK: Backend selection

    /// Trusted input is the default on macOS because whole categories of work
    /// depend on it — file pickers, `window.open`, anything gated on transient
    /// user activation. Dropping to the JS backend keeps the agent working but
    /// loses those; it exists so the substrate is testable and so a future iOS
    /// target has a floor to stand on.
    public func useTrustedInput(_ trusted: Bool) {
        let backend: ActuationBackend = trusted ? nativeBackend : jsBackend
        controller.setBackend(backend)
        backendName = backend.name
    }

    /// `CGEvent` posting fixes hover desync but needs the Accessibility grant —
    /// a prompt the user must be told about first, and one that is routinely
    /// fatal in App Store review for automation-centric apps.
    public func setAdvancedInput(_ enabled: Bool) {
        nativeBackend.advancedMode = enabled
    }

    // MARK: Navigation

    public func navigate(_ url: String) {
        Task { _ = await controller.navigate(url) }
    }

    public func newTab() {
        _ = try? tabManager.openTab(url: "about:blank")
    }

    public func selectTab(_ id: String) {
        _ = tabManager.activate(id)
    }

    public func closeTab(_ id: String) {
        _ = tabManager.closeTab(id)
    }

    // MARK: Running

    public func run(goal: String) {
        guard !isRunning else { return }
        let trimmed = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        isRunning = true
        answer = ""
        narration = []
        plan = []
        status = "Planning…"

        let model = RemoteAgentModel(
            apiBase: modelConfiguration.apiBase,
            getAuthToken: modelConfiguration.authToken
        )
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("LYKNAgent")
        let memory = FileMemoryStore(supportDirectory: support)

        runTask = Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await AgentLoop.run(
                    options: AgentRunOptions(
                        goal: trimmed,
                        userAsk: trimmed,
                        supportDirectory: support
                    ),
                    controller: controller,
                    model: model,
                    memory: memory,
                    onProgress: { [weak self] progress in
                        Task { @MainActor in self?.handle(progress) }
                    },
                    onApprovalNeeded: { [weak self] question, _ in
                        guard let self else { return false }
                        return await requestApproval(question)
                    },
                    onNeedsUser: { [weak self] _, question, _ in
                        guard let self else { return nil }
                        return await requestHandover(question)
                    }
                )
                finish(result)
            } catch let error as AgentModelUnavailableError {
                fail("The agent model is unavailable: \(error.message)")
            } catch {
                fail("The run failed: \(error.localizedDescription)")
            }
        }
    }

    public func cancel() {
        runTask?.cancel()
        runTask = nil
        isRunning = false
        status = "Cancelled"
    }

    private func handle(_ progress: AgentProgress) {
        switch progress {
        case .planning(let goal):
            status = "Planning: \(goal)"
        case .working(let steps, let skills):
            plan = steps
            status = skills.isEmpty ? "Working" : "Working (\(skills.joined(separator: ", ")))"
        case .acting(_, let action, let reason, let targetLabel, _):
            let what = reason.isEmpty ? (action?.type ?? "acting") : reason
            let detail = targetLabel.isEmpty ? what : "\(what) — \(targetLabel)"
            narration.append(NarrationLine(text: detail, kind: .step))
            status = detail
        case .recovering(let mode, _):
            narration.append(
                NarrationLine(text: "Recovering (\(mode.rawValue))", kind: .recovery)
            )
        case .replanning(let reason):
            narration.append(NarrationLine(text: "Replanning: \(reason)", kind: .recovery))
        case .waitingForUser(_, let question):
            status = question
        case .resumedAfterUser:
            narration.append(NarrationLine(text: "Resuming where we left off", kind: .handover))
        }
        tabs = tabManager.tabInfos()
    }

    private func finish(_ result: AgentRunResult) {
        isRunning = false
        answer = result.answer
        status = result.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
        narration.append(NarrationLine(text: result.answer, kind: .result))
        tabs = tabManager.tabInfos()
    }

    private func fail(_ message: String) {
        isRunning = false
        status = "Failed"
        answer = message
        narration.append(NarrationLine(text: message, kind: .result))
    }

    // MARK: Interaction

    private func requestApproval(_ question: String) async -> Bool {
        await withCheckedContinuation { continuation in
            pendingApproval = PendingApproval(question: question, continuation: continuation)
        }
    }

    public func answerApproval(_ approved: Bool) {
        guard let pending = pendingApproval else { return }
        pendingApproval = nil
        pending.continuation.resume(returning: approved)
    }

    private func requestHandover(_ question: String) async -> UserAssist? {
        await withCheckedContinuation { continuation in
            narration.append(NarrationLine(text: question, kind: .handover))
            pendingHandover = PendingHandover(question: question, continuation: continuation)
        }
    }

    /// The user says they have taken the step. The loop re-reads the page,
    /// resets the failure history, and earns extra rounds.
    public func resolveHandover(resumed: Bool, note: String = "") {
        guard let pending = pendingHandover else { return }
        pendingHandover = nil
        pending.continuation.resume(
            returning: resumed ? UserAssist(resumed: true, note: note) : nil
        )
    }
}
