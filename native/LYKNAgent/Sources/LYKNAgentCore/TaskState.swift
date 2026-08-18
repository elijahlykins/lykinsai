import Foundation

/// Explicit task state for a browser-agent run.
///
/// Kept in memory for the duration of the task (the app persists chat history
/// separately); the debug log gives a durable trace.
///
/// Ported from `electron/browser-agent/runtime/taskState.cjs`. Modelled as a
/// class because the loop mutates one task object throughout, exactly as the
/// JS original does.

public struct PlanStep: Sendable, Equatable {
    public var step: String
    public var done: Bool

    public init(step: String, done: Bool = false) {
        self.step = step
        self.done = done
    }
}

public struct RecordedAction: Sendable {
    public var timestamp: Date
    public var action: AgentAction?
    public var expectedOutcome: String
    /// "success" | "failure" — matched literally by the finish-evidence gate.
    public var result: String
    public var observedOutcome: String
    public var retries: Int
}

public struct WorkingMemory: Sendable {
    public var facts: [String] = []
    public var candidateResults: [String] = []
    public var openQuestions: [String] = []
    public var completedSteps: [String] = []
}

public enum TaskStatus: String, Sendable {
    case planning
    case working
    case waitingForUser = "waiting_for_user"
    case completed
    case failed
}

public struct ConversationTurn: Sendable {
    public var role: String
    public var content: String

    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
}

/// Confined to a single agent loop; never shared across concurrent runs.
public final class AgentTask: @unchecked Sendable {
    public let id: String
    public let goal: String
    public var status: TaskStatus = .planning
    public var plan: [PlanStep] = []
    public var currentStep: Int = 0
    public var skills: [String] = []
    public var knownFacts: [String: String] = [:]
    public var constraints: [String] = []
    public var workingMemory = WorkingMemory()
    public var recentActions: [RecordedAction] = []
    public var archivedActionCount: Int = 0
    public var retryCount: Int = 0
    public var round: Int = 0
    public var conversationHistory: [ConversationTurn]
    public let startedAt: Date
    public var completionReason: String = ""

    public init(goal: String, conversationHistory: [ConversationTurn] = []) {
        id = "task-\(UUID().uuidString)"
        self.goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
        self.conversationHistory = conversationHistory
        startedAt = Date()
    }
}

public enum TaskStateStore {
    static let maxRecentActions = 40

    public static func setPlan(
        _ task: AgentTask,
        plan: [String] = [],
        constraints: [String] = [],
        knownFacts: [String: String] = [:],
        skills: [String] = []
    ) {
        task.plan = plan.map { PlanStep(step: $0) }
        task.currentStep = 0
        task.constraints = constraints
        task.knownFacts.merge(knownFacts) { _, new in new }
        for skill in skills where !task.skills.contains(skill) {
            task.skills.append(skill)
        }
        task.status = .working
    }

    public static func recordAction(_ task: AgentTask, _ entry: RecordedAction) {
        task.recentActions.append(entry)
        // Compact old history instead of growing forever: fold the oldest
        // entries into one-line summaries in working memory.
        while task.recentActions.count > maxRecentActions {
            let old = task.recentActions.removeFirst()
            task.archivedActionCount += 1
            task.workingMemory.completedSteps.append(summarizeAction(old))
            if task.workingMemory.completedSteps.count > 60 {
                task.workingMemory.completedSteps.removeFirst(
                    task.workingMemory.completedSteps.count - 60
                )
            }
        }
    }

    static func summarizeAction(_ entry: RecordedAction) -> String {
        let action = entry.action
        var bits: [String] = [action?.type.isEmpty == false ? action!.type : "action"]
        if let target = action?.target, !target.isEmpty { bits.append(target) }
        if let url = action?.url, !url.isEmpty { bits.append(String(url.prefix(60))) }
        if let text = action?.text, !text.isEmpty { bits.append("\"\(String(text.prefix(30)))\"") }
        bits.append(entry.result == "success" ? "ok" : (entry.result.isEmpty ? "?" : entry.result))
        return bits.joined(separator: " ")
    }

    public static func addFact(_ task: AgentTask, _ fact: String) {
        let text = fact.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard !task.workingMemory.facts.contains(text) else { return }
        task.workingMemory.facts.append(text)
        if task.workingMemory.facts.count > 40 { task.workingMemory.facts.removeFirst() }
    }

    public static func markStepDone(_ task: AgentTask) {
        guard task.currentStep >= 0, task.currentStep < task.plan.count else { return }
        task.plan[task.currentStep].done = true
        task.currentStep = min(task.currentStep + 1, task.plan.count)
    }

    /// Compact, model-facing rendering of the task state.
    public static func formatTaskForModel(_ task: AgentTask) -> String {
        var lines = ["GOAL: \(task.goal)"]
        if !task.constraints.isEmpty {
            lines.append("CONSTRAINTS: \(task.constraints.joined(separator: "; "))")
        }
        if !task.plan.isEmpty {
            lines.append("PLAN:")
            for (index, step) in task.plan.enumerated() {
                let marker = step.done ? "[done]" : (index == task.currentStep ? "[now]" : "[later]")
                lines.append("  \(marker) \(step.step)")
            }
        }
        let facts = task.workingMemory.facts
        if !facts.isEmpty {
            lines.append("FACTS LEARNED:")
            for fact in facts.suffix(15) { lines.append("  - \(fact)") }
        }
        let candidates = task.workingMemory.candidateResults
        if !candidates.isEmpty {
            lines.append("CANDIDATE RESULTS:")
            for candidate in candidates.suffix(8) { lines.append("  - \(candidate)") }
        }
        return lines.joined(separator: "\n")
    }

    /// Compact recent-action history for the model.
    public static func formatHistoryForModel(_ task: AgentTask, max: Int = 12) -> String {
        var lines: [String] = []
        if task.archivedActionCount > 0 {
            lines.append(
                "(\(task.archivedActionCount) earlier actions summarized in working memory)"
            )
        }
        for entry in task.recentActions.suffix(max) {
            let action = entry.action
            var line = action?.type.isEmpty == false ? action!.type : "action"
            if let target = action?.target, !target.isEmpty { line += " \(target)" }
            if let url = action?.url, !url.isEmpty { line += " \(String(url.prefix(80)))" }
            if let text = action?.text, !text.isEmpty {
                line += " text=\"\(String(text.prefix(40)))\""
            }
            line += " -> \(entry.result.isEmpty ? "?" : entry.result)"
            if !entry.observedOutcome.isEmpty {
                line += " (\(String(entry.observedOutcome.prefix(120))))"
            }
            lines.append(line)
        }
        return lines.isEmpty ? "(no actions yet)" : lines.joined(separator: "\n")
    }
}
