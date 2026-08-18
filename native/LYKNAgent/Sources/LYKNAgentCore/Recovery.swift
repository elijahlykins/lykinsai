import Foundation

/// Recovery system — explicit, tracked behavior when an action fails or
/// verification shows no progress. Retries are counted per action signature in
/// structured state (never by asking the model to remember); after 2 retries of
/// essentially the same operation the strategy escalates.
///
/// Ported from `electron/browser-agent/runtime/recovery.cjs`.
public enum RecoveryLimits {
    public static let maxSameActionRetries = 2
    public static let maxTotalRecoveries = 6
    /// Visual inspection is worth repeating. A single screenshot for the whole
    /// task meant that once it was spent, later failures on a completely
    /// different screen had no way to look at what was actually there.
    public static let maxVisualRecoveries = 3
}

public enum RecoveryMode: String, Sendable {
    case retryFresh = "retry_fresh"
    case findEquivalent = "find_equivalent"
    case visual
    case replan
    case fail
}

public struct RecoveryStep: Sendable {
    public let mode: RecoveryMode
    public let hint: String
}

public final class RecoveryTracker: @unchecked Sendable {
    private var failuresBySignature: [String: Int] = [:]
    private var totalRecoveries = 0
    private var visualUses = 0

    private static let staleRefPattern = RE(
        #"stale_reference|unknown_reference|element not found|element_not_found"#
    )

    public init() {}

    public func signature(of decision: AgentDecision) -> String {
        let action = decision.action
        return [
            action?.type ?? "",
            action?.target ?? "",
            String((action?.url ?? "").prefix(80)),
            String((action?.text ?? "").prefix(40)),
        ]
        .joined(separator: "|")
        .lowercased()
    }

    /// Decide the next recovery step for a failed action.
    ///
    /// Ladder: refresh snapshot & retry → find equivalent target → visual
    /// inspection → replan → give up.
    public func nextRecoveryStep(
        decision: AgentDecision,
        verification: Verification?
    ) -> RecoveryStep {
        totalRecoveries += 1
        if totalRecoveries > RecoveryLimits.maxTotalRecoveries {
            return RecoveryStep(mode: .fail, hint: "recovery budget exhausted")
        }
        if verification?.next == .replan {
            let reason = verification?.reason ?? ""
            return RecoveryStep(
                mode: .replan,
                hint: reason.isEmpty ? "verifier requested replan" : reason
            )
        }

        let sig = signature(of: decision)
        let count = (failuresBySignature[sig] ?? 0) + 1
        failuresBySignature[sig] = count

        let staleRef = Self.staleRefPattern.test(verification?.reason ?? "")

        if count == 1 {
            let hint =
                staleRef
                ? "The element reference went stale. Re-observe the page and act on the equivalent element in the fresh snapshot."
                : "The action did not produce the expected result (\(verification?.reason.isEmpty == false ? verification!.reason : "no progress")). Re-observe and retry — the target may have moved, or the page may have changed unexpectedly."
            return RecoveryStep(mode: .retryFresh, hint: hint)
        }
        if count == 2 {
            return RecoveryStep(
                mode: .findEquivalent,
                hint:
                    "The same action failed twice. Do NOT repeat it. Look for a different element or route that accomplishes the same step (same role/purpose, different target)."
            )
        }
        if visualUses < RecoveryLimits.maxVisualRecoveries {
            visualUses += 1
            return RecoveryStep(
                mode: .visual,
                hint:
                    "Semantic targeting keeps failing — a screenshot of the page is attached. "
                    + "Find the target in the image. If it is visible there but missing from the "
                    + "element list, act on it directly with click_coord (or drag) using 0-1000 "
                    + "coordinates read off the image. If the image shows the approach itself is "
                    + "wrong, say so and replan."
            )
        }
        return RecoveryStep(
            mode: .replan,
            hint:
                "Repeated failures on \"\(decision.action?.type ?? "action")\" — the current approach appears invalid. Replan the remaining work."
        )
    }

    public func retries(for decision: AgentDecision) -> Int {
        failuresBySignature[signature(of: decision)] ?? 0
    }

    public func totalCount() -> Int { totalRecoveries }

    /// The environment changed underneath us in a way that invalidates the
    /// failure history — the user signed in, cleared a wall, or advanced the
    /// page by hand. Past failures describe a page that no longer exists, so
    /// the agent gets a fresh budget rather than inheriting a spent one.
    public func reset() {
        failuresBySignature.removeAll()
        totalRecoveries = 0
        visualUses = 0
    }
}
