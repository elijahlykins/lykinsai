import Foundation

/// Planner — converts a user goal into an editable high-level plan and revises
/// it when the environment makes the original plan obsolete.
///
/// Ported from `electron/browser-agent/runtime/planner.cjs`.
public enum Planner {
    public static func planTask(
        model: AgentModel,
        router: ContextRouter,
        instructions: Instructions,
        task: AgentTask,
        snapshot: PageSnapshot? = nil,
        userMemory: String = ""
    ) async throws -> String {
        let heuristicSkills = router.routeSkills(task.goal)
        let availableSkills = instructions.listSkills()

        let user = [
            "USER GOAL:\n\(task.goal)",
            task.conversationHistory.isEmpty
                ? "" : "RECENT CONVERSATION:\n\(formatConversation(task.conversationHistory))",
            userMemory.isEmpty
                ? "" : "REMEMBERED ABOUT THE USER:\n\(String(userMemory.prefix(1200)))",
            "AVAILABLE SKILLS: \(availableSkills.isEmpty ? "(none)" : availableSkills.joined(separator: ", "))",
            snapshot == nil
                ? ""
                : "CURRENT PAGE:\n\(SnapshotBuilder.formatSnapshotForModel(snapshot, maxElements: 25, maxTextChars: 1200))",
            "TODAY: \(dateString())",
        ]
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")

        let result = try await model.plan(system: router.buildPlanningSystem(), user: user)

        var skills: [String] = []
        for skill in heuristicSkills + result.skills
        where availableSkills.contains(skill) && !skills.contains(skill) {
            skills.append(skill)
        }

        TaskStateStore.setPlan(
            task,
            plan: result.plan.isEmpty ? ["Work toward: \(task.goal)"] : result.plan,
            constraints: result.constraints,
            knownFacts: result.knownFacts,
            skills: skills
        )
        return result.clarification
    }

    public static func replanTask(
        model: AgentModel,
        router: ContextRouter,
        task: AgentTask,
        snapshot: PageSnapshot?,
        reason: String = ""
    ) async throws -> String {
        let user = [
            "USER GOAL:\n\(task.goal)",
            "CURRENT TASK STATE:\n\(TaskStateStore.formatTaskForModel(task))",
            "RECENT ACTIONS:\n\(TaskStateStore.formatHistoryForModel(task))",
            "WHY THE CURRENT PLAN NO LONGER FITS:\n\(reason.isEmpty ? "(unknown)" : reason)",
            snapshot == nil
                ? ""
                : "CURRENT PAGE:\n\(SnapshotBuilder.formatSnapshotForModel(snapshot, maxElements: 30, maxTextChars: 1500))",
            "Produce a REVISED plan for the remaining work only. Keep constraints and knownFacts consistent with what was already learned.",
        ]
        .filter { !$0.isEmpty }
        .joined(separator: "\n\n")

        let result = try await model.plan(system: router.buildPlanningSystem(), user: user)
        if !result.plan.isEmpty {
            TaskStateStore.setPlan(
                task,
                plan: result.plan,
                constraints: result.constraints.isEmpty ? task.constraints : result.constraints,
                knownFacts: result.knownFacts,
                skills: result.skills
            )
        }
        return result.clarification
    }

    static func formatConversation(_ history: [ConversationTurn]) -> String {
        history.suffix(6)
            .map { turn in
                let who = turn.role == "assistant" ? "Assistant" : "User"
                return "\(who): \(String(turn.content.prefix(300)))"
            }
            .joined(separator: "\n")
    }

    /// Matches JS `new Date().toDateString()` — e.g. "Mon Aug 17 2026".
    static func dateString(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "EEE MMM dd yyyy"
        return formatter.string(from: date)
    }
}
